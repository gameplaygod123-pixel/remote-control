// Diagnoses whether the active connection is going direct (P2P) or through
// the TURN relay -- the free Open Relay Project demo server shares
// bandwidth across everyone using it, so a relayed connection can be
// noticeably slower for file transfer (and, to a lesser extent, video)
// than a direct path between the two machines' own networks. Useful to
// know before assuming a slow transfer is a bug in this app.
export type ConnectionType = 'direct' | 'relay' | 'unknown'

export async function getConnectionType(pc: RTCPeerConnection): Promise<ConnectionType> {
  const stats = await pc.getStats()
  let pair: RTCIceCandidatePairStats | undefined

  stats.forEach((report) => {
    if (
      report.type === 'candidate-pair' &&
      (report as RTCIceCandidatePairStats).state === 'succeeded'
    ) {
      const candidatePair = report as RTCIceCandidatePairStats
      // Prefer the one explicitly marked selected/nominated; fall back to
      // any succeeded pair if the browser doesn't report that flag.
      if (candidatePair.nominated || !pair) pair = candidatePair
    }
  })
  if (!pair) return 'unknown'

  const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : undefined
  const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined
  const isRelay = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
  return isRelay ? 'relay' : 'direct'
}
