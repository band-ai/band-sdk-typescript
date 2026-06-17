/**
 * Setup-only plugin entry for the Band channel.
 *
 * Intentionally transport-free: it builds the channel plugin with NO gateway
 * (the default), so loading this module for the setup wizard never imports the
 * WS transport or opens a connection.
 */

import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { createBandChannelPlugin } from "./channel.js";

export default defineSetupPluginEntry(createBandChannelPlugin());
