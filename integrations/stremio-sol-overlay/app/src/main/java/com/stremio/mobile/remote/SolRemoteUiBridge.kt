package com.stremio.mobile.remote

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * Keeps the LAN server independent from Compose/ViewModels while still allowing remote playback
 * to bring the existing PlayerScreen to the foreground.
 */
object SolRemoteUiBridge {
    sealed interface Event {
        data object OpenPlayer : Event
    }

    private val mutableEvents = MutableSharedFlow<Event>(extraBufferCapacity = 8)
    val events: SharedFlow<Event> = mutableEvents.asSharedFlow()

    fun openPlayer() {
        mutableEvents.tryEmit(Event.OpenPlayer)
    }
}
