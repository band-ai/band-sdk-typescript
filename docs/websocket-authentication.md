# WebSocket authentication and diagnostics

The Node transport sends the configured API key in the `x-api-key` upgrade
header on initial connections and reconnects. It never retries with query
authentication. Configured `api_key` query parameters are removed, including
encoded and mixed-case names. Harmless repeated query parameters are retained.
The socket base URL may include the `/websocket` suffix.

A nonempty `token` query parameter conflicts with API-key authentication and
is rejected. URLs containing userinfo or fragments are also rejected. Use a
supported platform that accepts header authentication; a failed header upgrade
does not enable a legacy authentication mode.

A custom `websocketFactory` owns its handshake headers. It must supply
`x-api-key` itself; browser WebSocket constructors cannot set this header.
The SDK does not inject credentials into a custom factory's URL or log output.

The transport sanitizes its diagnostic records before forwarding them to a
custom or built-in logger. Configured and removed legacy credentials are
protected in raw and URL-encoded text. Transport objects are omitted from
diagnostic projections because they can retain complete authenticated requests.
Errors are logged as safe copies rather than preserving object identity.
Disconnect reasons are sanitized before they enter returned errors, cached
state or terminal callbacks. Custom factories and application loggers remain
responsible for diagnostics they emit independently of the SDK.
