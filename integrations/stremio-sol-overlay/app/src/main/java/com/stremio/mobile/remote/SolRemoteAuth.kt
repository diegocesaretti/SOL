package com.stremio.mobile.remote

import android.content.Context
import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom

class SolRemoteAuth(context: Context) {
    data class PairingWindow(val code: String, val expiresAtMs: Long)

    private val prefs = context.getSharedPreferences("sol_remote_control", Context.MODE_PRIVATE)
    private val random = SecureRandom()

    @Volatile private var pairingCode: String? = null
    @Volatile private var pairingExpiresAtMs: Long = 0L
    @Volatile private var failedPairAttempts: Int = 0

    val paired: Boolean
        get() = !prefs.getString("control_token", null).isNullOrBlank()

    fun pairingOpen(nowMs: Long = System.currentTimeMillis()): Boolean =
        pairingCode != null && pairingExpiresAtMs > nowMs && failedPairAttempts < 10

    @Synchronized
    fun openPairingWindow(durationMs: Long = 5 * 60_000L): PairingWindow {
        val code = random.nextInt(1_000_000).toString().padStart(6, '0')
        val expiresAt = System.currentTimeMillis() + durationMs.coerceIn(30_000L, 15 * 60_000L)
        pairingCode = code
        pairingExpiresAtMs = expiresAt
        failedPairAttempts = 0
        return PairingWindow(code, expiresAt)
    }

    @Synchronized
    fun closePairingWindow() {
        pairingCode = null
        pairingExpiresAtMs = 0L
        failedPairAttempts = 0
    }

    @Synchronized
    fun pair(code: String): String? {
        val expected = pairingCode ?: return null
        if (!pairingOpen()) {
            closePairingWindow()
            return null
        }
        val matches = MessageDigest.isEqual(
            expected.toByteArray(Charsets.UTF_8),
            code.trim().toByteArray(Charsets.UTF_8),
        )
        if (!matches) {
            failedPairAttempts += 1
            if (failedPairAttempts >= 10) closePairingWindow()
            return null
        }

        val bytes = ByteArray(32).also(random::nextBytes)
        val token = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        prefs.edit().putString("control_token", token).apply()
        closePairingWindow()
        return token
    }

    fun revoke() {
        prefs.edit().remove("control_token").apply()
        closePairingWindow()
    }

    fun verifyAuthorization(header: String?): Boolean {
        val stored = prefs.getString("control_token", null)?.takeIf { it.isNotBlank() } ?: return false
        val candidate = header
            ?.takeIf { it.startsWith("Bearer ", ignoreCase = true) }
            ?.substringAfter(' ')
            ?.trim()
            ?.takeIf { it.isNotBlank() }
            ?: return false
        return MessageDigest.isEqual(
            stored.toByteArray(Charsets.UTF_8),
            candidate.toByteArray(Charsets.UTF_8),
        )
    }
}
