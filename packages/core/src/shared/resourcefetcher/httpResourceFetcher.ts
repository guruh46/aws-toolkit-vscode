/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { VSCODE_EXTENSION_ID } from '../extensions'
import { getLogger, Logger } from '../logger/logger'
import { ResourceFetcher } from './resourcefetcher'
import { Timeout, CancelEvent, waitUntil } from '../utilities/timeoutUtils'
import request, { RequestError } from '../request'
import { isUserCancelledError } from '../errors'

type RequestHeaders = { eTag?: string; gZip?: boolean }

export class HttpResourceFetcher implements ResourceFetcher<Response> {
    private readonly logger: Logger = getLogger()

    /**
     *
     * @param url URL to fetch a response body from via the `get` call
     * @param params Additional params for the fetcher
     * @param {boolean} params.showUrl Whether or not to the URL in log statements.
     * @param {string} params.friendlyName If URL is not shown, replaces the URL with this text.
     * @param {Timeout} params.timeout Timeout token to abort/cancel the request. Similar to `AbortSignal`.
     * @param {number} params.retries The number of retries a get request should make if one fails
     * @param {boolean} params.throwOnError True if we want to throw if there's request error, defaul to false
     */
    public constructor(
        private readonly url: string,
        private readonly params: {
            showUrl: boolean
            friendlyName?: string
            timeout?: Timeout
            throwOnError?: boolean
        }
    ) {
        this.params.throwOnError = this.params.throwOnError ?? false
    }

    /**
     * Returns the response of the resource, or undefined if the response failed could not be retrieved.
     */
    public get(): Promise<Response | undefined> {
        this.logger.verbose(`downloading: ${this.logText()}`)
        return this.downloadRequest()
    }

    /**
     * Requests for new content but additionally uses the given E-Tag.
     * If no E-Tag is given it behaves as a normal request.
     *
     * @param eTag
     * @returns object with optional content. If content is undefined it implies the provided
     *          E-Tag matched the server's, so no content was in response. E-Tag is the E-Tag
     *          of the latest content
     */
    public async getNewETagContent(eTag?: string): Promise<{ content?: string; eTag: string }> {
        const response = await this.getResponseFromGetRequest(this.params.timeout, { eTag, gZip: true })

        const eTagResponse = response.headers.get('etag')
        if (!eTagResponse) {
            throw new Error(`This URL does not support E-Tags. Cannot use this function for: ${this.url.toString()}`)
        }

        // NOTE: Even with use of `gzip` encoding header, the response content is uncompressed.
        // Most likely due to the http request library uncompressing it for us.
        let contents: string | undefined = await response.text()
        if (response.status === 304) {
            // Explanation: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match
            contents = undefined
            this.logger.verbose(`E-Tag matched (${eTagResponse}). Download skipped: ${this.url}`)
        } else {
            this.logger.verbose(`E-Tag not matched. Downloaded: ${this.logText()}`)
        }

        return { content: contents, eTag: eTagResponse }
    }

    private async downloadRequest(): Promise<Response | undefined> {
        try {
            const resp = await this.getResponseFromGetRequest(this.params.timeout)
            this.logger.verbose(`downloaded: ${this.logText()}`)
            return resp
        } catch (err) {
            const error = err as RequestError
            this.logger.verbose(
                `Error downloading ${this.logText()}: %s`,
                error.message ?? error.code ?? error.response.statusText ?? error.response.status
            )
            if (this.params.throwOnError) {
                throw error
            }
            return undefined
        }
    }

    private logText(): string {
        return this.params.showUrl ? this.url : (this.params.friendlyName ?? 'resource from URL')
    }

    private logCancellation(event: CancelEvent) {
        getLogger().debug(`Download for "${this.logText()}" ${event.agent === 'user' ? 'cancelled' : 'timed out'}`)
    }

    private async getResponseFromGetRequest(timeout?: Timeout, headers?: RequestHeaders): Promise<Response> {
        return waitUntil(
            () => {
                const req = request.fetch('GET', this.url, {
                    headers: this.buildRequestHeaders(headers),
                })

                const cancelListener = timeout?.token.onCancellationRequested((event) => {
                    this.logCancellation(event)
                    req.cancel()
                })

                return req.response.finally(() => cancelListener?.dispose())
            },
            {
                timeout: 3000,
                interval: 100,
                backoff: 2,
                retryOnFail: (error: Error) => {
                    // Retry unless the user intentionally canceled the operation.
                    return !isUserCancelledError(error)
                },
            }
        )
    }

    private buildRequestHeaders(requestHeaders?: RequestHeaders): Headers {
        const headers = new Headers()

        headers.set('User-Agent', VSCODE_EXTENSION_ID.awstoolkit)

        if (requestHeaders?.eTag !== undefined) {
            headers.set('If-None-Match', requestHeaders.eTag)
        }

        if (requestHeaders?.gZip) {
            headers.set('Accept-Encoding', 'gzip')
        }

        return headers
    }
}

/**
 * Retrieves JSON property value from a remote resource
 * @param property property to retrieve
 * @param url url of JSON resource
 * @param fetcher optional HTTP resource fetcher to use
 * @returns property value if available or undefined
 */
export async function getPropertyFromJsonUrl(
    url: string,
    property: string,
    fetcher?: HttpResourceFetcher
): Promise<any | undefined> {
    const resourceFetcher = fetcher ?? new HttpResourceFetcher(url, { showUrl: true })
    const resp = await resourceFetcher.get()
    const result = await resp?.text()
    if (result) {
        try {
            const json = JSON.parse(result)
            if (json[property]) {
                return json[property]
            }
        } catch (err) {
            getLogger().error(`JSON parsing failed for "${url}": ${(err as Error).message}`)
        }
    }
}
