package com.junkyardolympics.tv

import kotlin.math.max
import kotlin.math.min

/** Bounded exponential retry schedule: 1, 2, 4, 8, then 15 seconds. */
class RetryPolicy {
    private var attempt = 0

    fun nextDelayMillis(): Long = delayMillis(attempt++)

    fun reset() {
        attempt = 0
    }

    companion object {
        fun delayMillis(attempt: Int): Long {
            val boundedAttempt = min(max(attempt, 0), 4)
            return min(1_000L shl boundedAttempt, 15_000L)
        }
    }
}
