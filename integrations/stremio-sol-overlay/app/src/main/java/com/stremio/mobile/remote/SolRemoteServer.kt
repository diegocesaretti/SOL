package com.stremio.mobile.remote

import android.content.Context
import com.stremio.mobile.di.AppContainer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets

class SolRemoteServer(
    context: Context,
    container: AppContainer,
    private val port: Int = 8768,
) {
    private data class HttpRequest(
        val method: String,
        val path: String,
        val headers: Map<String, String>,
        val body: String,
    )

    private val appContext = context.applicationContext
    private val auth = SolRemoteAuth(appContext)
    private val controller = SolRemoteController(container)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var serverSocket: ServerSocket? = null
    private var acceptJob: Job? = null

    val paired: Boolean get() = auth.paired
    val isRunning: Boolean get() = serverSocket?.isClosed == false

    fun openPairingWindow(): SolRemoteAuth.PairingWindow = auth.openPairingWindow()
    fun revokePairing() = auth.revoke()

    @Synchronized
    fun start() {
        if (isRunning) return
        val socket = ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress("0.0.0.0", port))
        }
        serverSocket = socket
        acceptJob = scope.launch {
            while (isActive && !socket.isClosed) {
                val client = runCatching { socket.accept() }.getOrNull() ?: break
                launch { handleClient(client) }
            }
        }
    }

    @Synchronized
    fun stop() {
        runCatching { serverSocket?.close() }
        serverSocket = null
        acceptJob?.cancel()
        acceptJob = null
    }

    fun close() {
        stop()
        scope.cancel()
    }

    private suspend fun handleClient(socket: Socket) {
        socket.use { client ->
            client.soTimeout = 15_000
            val output = BufferedOutputStream(client.getOutputStream())
            try {
                val request = readRequest(BufferedInputStream(client.getInputStream()))
                val response = route(request)
                writeResponse(output, response.first, response.second)
            } catch (error: Throwable) {
                writeResponse(output, 500, JSONObject().put("error", error.message ?: "internal_error"))
            }
        }
    }

    private suspend fun route(request: HttpRequest): Pair<Int, JSONObject> {
        if (request.method == "GET" && request.path == "/api/v1/health") {
            return 200 to JSONObject()
                .put("ok", true)
                .put("service", "stremio-sol-control")
                .put("apiVersion", 1)
                .put("paired", auth.paired)
                .put("pairingOpen", auth.pairingOpen())
                .put("port", port)
        }

        if (request.method == "POST" && request.path == "/api/v1/pair") {
            val body = parseJson(request.body)
            val code = body.optString("code", "").trim()
            val clientName = body.optString("clientName", "SOL").take(80)
            val token = auth.pair(code)
                ?: return 403 to JSONObject().put("error", "invalid_or_expired_pairing_code")
            return 200 to JSONObject()
                .put("ok", true)
                .put("token", token)
                .put("device", JSONObject().put("name", android.os.Build.MODEL).put("client", clientName))
        }

        if (!auth.verifyAuthorization(request.headers["authorization"])) {
            return 401 to JSONObject().put("error", "bearer_token_required")
        }

        return when {
            request.method == "GET" && request.path == "/api/v1/status" -> 200 to controller.status()
            request.method == "GET" && request.path == "/api/v1/player" -> 200 to controller.playerState()
            request.method == "POST" && request.path == "/api/v1/search" -> {
                val body = parseJson(request.body)
                val query = body.optString("query", "").trim()
                val limit = body.optInt("limit", 12)
                200 to controller.search(query, limit)
            }
            request.method == "POST" && request.path == "/api/v1/details" -> {
                val body = parseJson(request.body)
                200 to controller.details(body.optString("type", ""), body.optString("id", ""))
            }
            request.method == "POST" && request.path == "/api/v1/play" -> {
                val body = parseJson(request.body)
                200 to controller.play(
                    type = body.optString("type", ""),
                    id = body.optString("id", ""),
                    videoId = body.optString("videoId", "").takeIf { it.isNotBlank() },
                    streamIndex = body.optInt("streamIndex", 0),
                    engine = body.optString("engine", "exo"),
                )
            }
            request.method == "POST" && request.path == "/api/v1/player/pause" -> 200 to controller.pause()
            request.method == "POST" && request.path == "/api/v1/player/resume" -> 200 to controller.resume()
            request.method == "POST" && request.path == "/api/v1/player/seek" -> {
                val body = parseJson(request.body)
                val position = if (body.has("positionMs") && !body.isNull("positionMs")) body.getLong("positionMs") else null
                val offset = if (body.has("offsetMs") && !body.isNull("offsetMs")) body.getLong("offsetMs") else null
                200 to controller.seek(position, offset)
            }
            request.method == "POST" && request.path == "/api/v1/player/audio" -> {
                val id = parseJson(request.body).optString("id", "")
                200 to controller.selectAudio(id)
            }
            request.method == "POST" && request.path == "/api/v1/player/subtitle" -> {
                val id = parseJson(request.body).optString("id", "")
                200 to controller.selectSubtitle(id)
            }
            request.method == "POST" && request.path == "/api/v1/player/subtitle/off" -> 200 to controller.disableSubtitles()
            else -> 404 to JSONObject().put("error", "not_found")
        }
    }

    private fun parseJson(body: String): JSONObject = if (body.isBlank()) JSONObject() else JSONObject(body)

    private fun readRequest(input: BufferedInputStream): HttpRequest {
        val headerBytes = ArrayList<Byte>(1024)
        var matched = 0
        val terminator = byteArrayOf(13, 10, 13, 10)
        while (headerBytes.size < 32 * 1024) {
            val next = input.read()
            if (next < 0) break
            val byte = next.toByte()
            headerBytes.add(byte)
            matched = if (byte == terminator[matched]) matched + 1 else if (byte == terminator[0]) 1 else 0
            if (matched == terminator.size) break
        }
        if (matched != terminator.size) throw IllegalArgumentException("invalid_http_headers")

        val headerText = headerBytes.toByteArray().toString(StandardCharsets.US_ASCII)
        val lines = headerText.split("\r\n")
        val requestLine = lines.firstOrNull()?.split(' ') ?: throw IllegalArgumentException("invalid_request_line")
        if (requestLine.size < 2) throw IllegalArgumentException("invalid_request_line")
        val method = requestLine[0].uppercase()
        val path = requestLine[1].substringBefore('?')
        val headers = buildMap {
            lines.drop(1).forEach { line ->
                val index = line.indexOf(':')
                if (index > 0) put(line.substring(0, index).trim().lowercase(), line.substring(index + 1).trim())
            }
        }
        val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
        if (contentLength !in 0..(256 * 1024)) throw IllegalArgumentException("request_too_large")
        val bodyBytes = ByteArray(contentLength)
        var offset = 0
        while (offset < contentLength) {
            val count = input.read(bodyBytes, offset, contentLength - offset)
            if (count < 0) throw IllegalArgumentException("unexpected_eof")
            offset += count
        }
        return HttpRequest(method, path, headers, bodyBytes.toString(StandardCharsets.UTF_8))
    }

    private fun writeResponse(output: BufferedOutputStream, status: Int, body: JSONObject) {
        val payload = body.toString().toByteArray(StandardCharsets.UTF_8)
        val reason = when (status) {
            200 -> "OK"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            403 -> "Forbidden"
            404 -> "Not Found"
            else -> "Internal Server Error"
        }
        val headers = "HTTP/1.1 $status $reason\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${payload.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        output.write(headers.toByteArray(StandardCharsets.US_ASCII))
        output.write(payload)
        output.flush()
    }
}
