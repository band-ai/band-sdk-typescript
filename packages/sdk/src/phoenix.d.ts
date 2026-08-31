// The `phoenix` package ships no types of its own, so the SDK relies on the
// DefinitelyTyped package for the Socket/Channel/Push surface. The only member it
// omits is the socket's own channel list, which the transport reads when logging.
import "phoenix";

declare module "phoenix" {
  interface Socket {
    channels: Channel[];
  }
}
