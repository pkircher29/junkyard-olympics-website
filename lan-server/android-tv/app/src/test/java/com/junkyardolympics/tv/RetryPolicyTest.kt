package com.junkyardolympics.tv

import org.junit.Assert.assertEquals
import org.junit.Test

class RetryPolicyTest {
    @Test fun `backoff starts promptly and doubles to cap`() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 15_000L),
            (0..5).map(RetryPolicy::delayMillis))
    }

    @Test fun `negative attempt is treated as first attempt`() {
        assertEquals(1_000L, RetryPolicy.delayMillis(-1))
    }

    @Test fun `success resets attempt counter`() {
        val policy = RetryPolicy()
        assertEquals(1_000L, policy.nextDelayMillis())
        assertEquals(2_000L, policy.nextDelayMillis())
        policy.reset()
        assertEquals(1_000L, policy.nextDelayMillis())
    }
}
