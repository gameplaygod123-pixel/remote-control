import { useEffect, useState } from 'react'
import ControllerView from './controller/ControllerView'
import AgentView from './agent/AgentView'
import SourceView from './loopback/SourceView'
import ViewerView from './loopback/ViewerView'
import InjectorTestView from './dev-test/InjectorTestView'
import CaptureTestView from './dev-test/CaptureTestView'
import ChooseModeView from './setup/ChooseModeView'

function App(): React.JSX.Element {
  const [mode, setMode] = useState<'agent' | 'controller' | null>(null)
  const role = new URLSearchParams(window.location.search).get('role')

  useEffect(() => {
    if (!role) window.api.getMode().then(setMode)
  }, [role])

  if (role === 'source') return <SourceView />
  if (role === 'viewer') return <ViewerView />
  if (role === 'injector-test') return <InjectorTestView />
  if (role === 'capture-test') return <CaptureTestView />
  if (role === 'choose-mode') return <ChooseModeView />
  if (mode === null) return <p>Loading...</p>
  return mode === 'agent' ? <AgentView /> : <ControllerView />
}

export default App
