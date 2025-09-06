package org.interchained.elara

/**
 * Exception thrown when an API rate limit is encountered
 */
class RateLimitException(message: String) : Exception(message)
