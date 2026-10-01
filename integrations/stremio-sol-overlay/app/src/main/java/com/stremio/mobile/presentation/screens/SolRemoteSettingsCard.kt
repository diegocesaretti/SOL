package com.stremio.mobile.presentation.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import com.stremio.mobile.MainApplication
import com.stremio.mobile.core.theme.MutedText

@Composable
fun SolRemoteSettingsCard() {
    val app = LocalContext.current.applicationContext as MainApplication
    var pairingCode by remember { mutableStateOf<String?>(null) }
    var pairingExpiresAtMs by remember { mutableStateOf<Long?>(null) }
    var paired by remember { mutableStateOf(app.solRemoteServer.paired) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "SOL REMOTE CONTROL",
            color = MutedText,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
        )

        SettingsClickRow(
            title = if (paired) "Pair another SOL session" else "Pair SOL",
            onClick = {
                val pairing = app.solRemoteServer.openPairingWindow()
                pairingCode = pairing.code
                pairingExpiresAtMs = pairing.expiresAtMs
                paired = app.solRemoteServer.paired
            },
            description = when {
                pairingCode != null -> "Code: $pairingCode · valid for 5 minutes. Enter this code only in your trusted SOL instance."
                paired -> "SOL is paired. Control API: TCP 8768 on your local network."
                else -> "Generate a one-time 6-digit code. The control API stays locked until pairing succeeds."
            },
        )

        if (paired) {
            SettingsClickRow(
                title = "Revoke SOL pairing",
                onClick = {
                    app.solRemoteServer.revokePairing()
                    paired = false
                    pairingCode = null
                    pairingExpiresAtMs = null
                },
                description = "Invalidates the current bearer token immediately. Pair again to restore remote control.",
            )
        }

        pairingExpiresAtMs?.let { expiresAt ->
            val remainingSeconds = ((expiresAt - System.currentTimeMillis()) / 1000L).coerceAtLeast(0L)
            if (pairingCode != null) {
                Text(
                    text = if (remainingSeconds > 0) "Pairing window open · up to ${remainingSeconds}s" else "Pairing code expired · generate a new one",
                    color = MutedText,
                    fontSize = 12.sp,
                )
            }
        }
    }
}
