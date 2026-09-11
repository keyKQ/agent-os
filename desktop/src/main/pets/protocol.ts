import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { PET_SCHEME } from '@shared/pet'
import type { PetStore } from './store'

/**
 * `agentos-pet://sheet/<slug>` streams a spritesheet from the pets directory
 * straight into an <img>, so a 2 MB sheet never crosses IPC as base64 and the
 * renderer's image cache does its job. The renderer's CSP lists the scheme
 * under img-src; nothing else is reachable through it.
 */
export function registerPetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
  ])
}

/** After `app.whenReady()`. */
export function servePets(store: PetStore): void {
  protocol.handle(PET_SCHEME, (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (url.hostname !== 'sheet') return new Response('not found', { status: 404 })
    const slug = url.pathname.replace(/^\/+/, '')
    const file = store.sheetPath(slug)
    if (!file) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString(), {
      headers: { 'Cache-Control': 'max-age=3600' },
    })
  })
}
