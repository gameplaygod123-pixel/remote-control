// Protocol capability strings exchanged in pair-request/connection-request
// (controller -> agent) and connection-response/pair-result (agent ->
// controller) -- see packages/protocol's `caps` fields. Both sides must
// advertise this before either one negotiates the native input-helper's
// separate input peer connection; otherwise they fall back to the original
// single-PC, renderer-owned input data channel. See
// docs/native-input-plan.md for the full design.
export const INPUT_HELPER_CAP = 'input-helper'
