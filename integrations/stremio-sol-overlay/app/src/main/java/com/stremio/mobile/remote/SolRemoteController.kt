package com.stremio.mobile.remote

import com.stremio.mobile.core.CoreStream
import com.stremio.mobile.data.model.StreamOption
import com.stremio.mobile.di.AppContainer
import com.stremio.mobile.player.PlayerEngine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

class SolRemoteController(private val container: AppContainer) {
    fun status(): JSONObject {
        val playback = container.playbackManager.state.value
        val player = container.playbackRepository.getPlayer()
        val runtime = player?.runtimeState?.value
        return JSONObject()
            .put("ok", true)
            .put("service", "stremio-sol-control")
            .put("playing", runtime?.isPlaying ?: playback.isPlaying)
            .put("title", playback.title)
            .put("activeUri", playback.activeUri)
            .put("playerEngine", player?.engine?.profileValue)
            .put("positionMs", runtime?.positionMs ?: 0L)
            .put("durationMs", runtime?.durationMs ?: 0L)
            .put("buffering", runtime?.isBuffering ?: false)
    }

    fun playerState(): JSONObject {
        val playback = container.playbackManager.state.value
        val player = container.playbackRepository.getPlayer()
        val runtime = player?.runtimeState?.value
        val audio = JSONArray()
        val subtitles = JSONArray()
        runtime?.audioTracks?.forEach { track ->
            audio.put(JSONObject()
                .put("id", track.id)
                .put("label", track.label)
                .put("language", track.language)
                .put("languageCode", track.languageCode)
                .put("selected", track.selected))
        }
        runtime?.subtitleTracks?.forEach { track ->
            subtitles.put(JSONObject()
                .put("id", track.id)
                .put("label", track.label)
                .put("language", track.language)
                .put("languageCode", track.languageCode)
                .put("origin", track.origin)
                .put("selected", track.selected))
        }
        return JSONObject()
            .put("ok", true)
            .put("title", playback.title)
            .put("activeUri", playback.activeUri)
            .put("playerPresent", player != null)
            .put("engine", player?.engine?.profileValue)
            .put("isPlaying", runtime?.isPlaying ?: playback.isPlaying)
            .put("isBuffering", runtime?.isBuffering ?: false)
            .put("positionMs", runtime?.positionMs ?: 0L)
            .put("durationMs", runtime?.durationMs ?: 0L)
            .put("bufferedPositionMs", runtime?.bufferedPositionMs ?: 0L)
            .put("speed", runtime?.speed ?: 1.0f)
            .put("ended", runtime?.ended ?: false)
            .put("error", runtime?.error)
            .put("subtitlesDisabled", runtime?.subtitlesDisabled ?: true)
            .put("audioTracks", audio)
            .put("subtitleTracks", subtitles)
    }

    suspend fun search(query: String, limit: Int): JSONObject {
        val trimmed = query.trim()
        require(trimmed.isNotEmpty()) { "search_query_required" }
        val boundedLimit = limit.coerceIn(1, 40)
        var rangeRequested = false
        val items = withTimeoutOrNull(7_000L) {
            container.catalogRepository.search(trimmed)
                .onEach {
                    if (!rangeRequested) {
                        rangeRequested = true
                        container.catalogRepository.loadSearchRange(0, maxOf(30, boundedLimit * 3))
                    }
                }
                .map { board ->
                    container.boardRepository.extractBoardShelves(board)
                        .flatMap { shelf -> shelf.items }
                        .distinctBy { "${it.type}:${it.id}" }
                        .take(boundedLimit)
                }
                .first { it.isNotEmpty() }
        } ?: emptyList()

        return JSONObject()
            .put("ok", true)
            .put("query", trimmed)
            .put("results", JSONArray().apply {
                items.forEach { item ->
                    put(JSONObject()
                        .put("type", item.type)
                        .put("id", item.id)
                        .put("name", item.name)
                        .put("releaseInfo", item.releaseInfo)
                        .put("poster", item.poster))
                }
            })
    }

    suspend fun details(type: String, id: String): JSONObject {
        require(type.isNotBlank() && id.isNotBlank()) { "type_and_id_required" }
        val details = withTimeoutOrNull(8_000L) {
            container.catalogRepository
                .getMetaDetailsFlow(type, id, videoId = null, guessStreamPath = false)
                .first { container.catalogRepository.extractVideos(it).isNotEmpty() || it.metaItem?.content != null }
        } ?: throw IllegalStateException("details_timeout")
        val videos = container.catalogRepository.extractVideos(details)
        return JSONObject()
            .put("ok", true)
            .put("type", type)
            .put("id", id)
            .put("videos", JSONArray().apply {
                videos.forEach { video ->
                    put(JSONObject()
                        .put("id", video.id)
                        .put("title", video.title)
                        .put("season", video.seriesInfo?.season?.toInt())
                        .put("episode", video.seriesInfo?.episode?.toInt())
                        .put("thumbnail", video.thumbnail))
                }
            })
    }

    suspend fun play(type: String, id: String, videoId: String?, streamIndex: Int, engine: String): JSONObject {
        require(type.isNotBlank() && id.isNotBlank()) { "type_and_id_required" }
        if (type.equals("series", ignoreCase = true) && videoId.isNullOrBlank()) {
            throw IllegalArgumentException("video_id_required_for_series")
        }

        container.serverController.start()
        val streamList = withTimeoutOrNull(15_000L) {
            container.catalogRepository
                .getMetaDetailsFlow(
                    type = type,
                    id = id,
                    videoId = videoId,
                    guessStreamPath = videoId.isNullOrBlank(),
                )
                .map { details -> container.catalogRepository.extractStreams(details) }
                .first { it.isNotEmpty() }
        } ?: throw IllegalStateException("streams_timeout")

        val index = streamIndex.coerceAtLeast(0)
        val selected = streamList.getOrNull(index) ?: throw IllegalArgumentException("stream_index_out_of_range")
        val option = selected.toStreamOption(index)
        val playerEngine = if (engine.equals("mpv", ignoreCase = true)) PlayerEngine.MPV else PlayerEngine.EXO
        val loaded = container.playbackRepository.resolveAndLoadStream(
            option = option,
            engine = playerEngine,
            displayTitle = option.name,
        )
        if (!loaded) throw IllegalStateException("stream_not_playable")
        SolRemoteUiBridge.openPlayer()
        return JSONObject()
            .put("ok", true)
            .put("type", type)
            .put("id", id)
            .put("videoId", videoId)
            .put("streamIndex", index)
            .put("streamCount", streamList.size)
            .put("addon", selected.addonTitle)
            .put("name", option.name)
            .put("engine", playerEngine.profileValue)
    }

    fun pause(): JSONObject {
        val player = requirePlayer()
        player.pause()
        container.playbackRepository.reportPausedChanged(true)
        return playerState()
    }

    fun resume(): JSONObject {
        val player = requirePlayer()
        player.play()
        container.playbackRepository.reportPausedChanged(false)
        return playerState()
    }

    fun seek(positionMs: Long?, offsetMs: Long?): JSONObject {
        require((positionMs == null) xor (offsetMs == null)) { "provide_exactly_one_seek_value" }
        val player = requirePlayer()
        val current = player.runtimeState.value
        val target = (positionMs ?: current.positionMs + (offsetMs ?: 0L))
            .coerceIn(0L, current.durationMs.takeIf { it > 0L } ?: Long.MAX_VALUE)
        player.seekTo(target)
        container.playbackRepository.reportSeek(target, current.durationMs)
        return playerState().put("requestedPositionMs", target)
    }

    fun selectAudio(id: String): JSONObject {
        val player = requirePlayer()
        val track = player.runtimeState.value.audioTracks.firstOrNull { it.id == id }
            ?: throw IllegalArgumentException("audio_track_not_found")
        player.selectAudioTrack(id)
        container.playbackRepository.rememberAudioTrack(track)
        return playerState()
    }

    fun selectSubtitle(id: String): JSONObject {
        val player = requirePlayer()
        val track = player.runtimeState.value.subtitleTracks.firstOrNull { it.id == id }
            ?: throw IllegalArgumentException("subtitle_track_not_found")
        player.selectSubtitleTrack(id)
        container.playbackRepository.rememberSubtitleTrack(track)
        return playerState()
    }

    fun disableSubtitles(): JSONObject {
        val player = requirePlayer()
        player.disableSubtitles()
        container.playbackRepository.rememberSubtitlesDisabled()
        return playerState()
    }

    private fun requirePlayer() = container.playbackRepository.getPlayer()
        ?: throw IllegalStateException("player_not_active")

    private fun CoreStream.toStreamOption(index: Int): StreamOption {
        val rawDescription = stream.description?.takeIf { it.isNotBlank() } ?: stream.thumbnail
        val quality = stream.name?.let { name ->
            listOf("2160p", "4k", "1080p", "720p", "480p").firstOrNull { name.contains(it, ignoreCase = true) }
        }
        return StreamOption(
            key = "$index-$addonTitle-${stream.name ?: ""}-${rawDescription ?: ""}",
            name = stream.name?.takeIf { it.isNotBlank() } ?: addonTitle,
            description = rawDescription,
            addonTitle = addonTitle,
            quality = quality,
            core = this,
        )
    }
}
