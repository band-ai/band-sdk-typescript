import { SEND_MESSAGE_TOOL_NAME } from "../../../../src/contracts/toolSchemas";

export const TOOL_REPLY_WORD = "pineapple";

/**
 * Asks for the reply through band_send_message and for closing narration in
 * plain text, so every run leaves text a double post would carry and the
 * model has no reason to deliver that narration with a second send.
 */
export const TOOL_REPLY_REQUEST = `Reply with the single word: ${TOOL_REPLY_WORD}. Send it with ${SEND_MESSAGE_TOOL_NAME}, then say in plain text that you sent it.`;
