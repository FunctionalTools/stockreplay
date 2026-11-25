import { createRoot } from 'react-dom/client'
import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import App from './App'
import { ReadingListProvider } from './SavedArticles'
import './style.css'

createRoot(document.getElementById('root')!).render(
  <ReadingListProvider>
    <App />
  </ReadingListProvider>,
)
