import { useEffect, useState } from 'react'
import ControllerView from './controller/ControllerView'
import AgentView from './agent/AgentView'
import SourceView from './loopback/SourceView'
import ViewerView from './loopback/ViewerView'
import InjectorTestView from './dev-test/InjectorTestView'
import CaptureTestView from './dev-test/CaptureTestView'
import ChooseModeView from './setup/ChooseModeView'
import TokenSetupView from './setup/TokenSetupView'

function App(): React.JSX.Element {
  const [mode, setMode] = useState<'agent' | 'controller' | null>(null)
  // false = known absent (show setup); string = present. Applies to both
  // modes: agents need the house token to register, controllers to
  // list/pair. In dev the main process supplies a fallback, so the setup
  // screen only ever appears on packaged installs.
  const [token, setToken] = useState<string | false | null>(null)
  const role = new URLSearchParams(window.location.search).get('role')

  useEffect(() => {
    if (!role) {
      window.api.getMode().then(setMode)
      window.api.houseToken.get().then((saved) => setToken(saved ?? false))
    }
  }, [role])

  if (role === 'source') return <SourceView />
  if (role === 'viewer') return <ViewerView />
  if (role === 'injector-test') return <InjectorTestView />
  if (role === 'capture-test') return <CaptureTestView />
  if (role === 'choose-mode') return <ChooseModeView />
  if (mode === null || token === null) return <p>Loading...</p>
  if (token === false) {
    return (
      <TokenSetupView
        onSaved={() => window.api.houseToken.get().then((saved) => setToken(saved ?? false))}
      />
    )
  }
  return mode === 'agent' ? <AgentView /> : <ControllerView />
}

export default App
