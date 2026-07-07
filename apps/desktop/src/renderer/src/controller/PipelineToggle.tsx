export type PipelineName = 'webrtc' | 'native'

// A single sidebar button that flips the controller's video pipeline between the
// default WebRTC path and the low-latency native path (VideoToolbox decode +
// in-window compositing). Per-machine, persisted via window.api.pipeline; it
// engages on the NEXT session because the receiver host is wired at startup.
// When native is selected it still only actually runs if the agent also opted in
// AND both peers negotiate the cap -- otherwise the session silently falls back
// to WebRTC (WebRTC is the safety net, never removed). See main/pipelineConfig.ts.

// Lightning bolt = native (fast, direct). Filled + accent when active.
const BoltIcon = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
)

export default function PipelineToggle({
  pipeline,
  onChange
}: {
  pipeline: PipelineName
  onChange: (p: PipelineName) => void
}): React.JSX.Element {
  const native = pipeline === 'native'
  return (
    <button
      type="button"
      className={`ctl-side__btn${native ? ' is-active' : ''}`}
      aria-pressed={native}
      title={
        native
          ? 'วิดีโอ: Native (ลื่นสุด) — คลิกเพื่อกลับไป WebRTC · มีผลรอบเชื่อมต่อถัดไป'
          : 'วิดีโอ: WebRTC (มาตรฐาน) — คลิกเพื่อใช้ Native (ลื่นสุด) · มีผลรอบเชื่อมต่อถัดไป'
      }
      onClick={() => onChange(native ? 'webrtc' : 'native')}
    >
      {BoltIcon}
    </button>
  )
}
