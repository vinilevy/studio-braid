import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(cleanup)

// jsdom has no clipboard implementation; keep it mockable without granting access.
if (!('clipboard' in navigator)) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined })
}

// jsdom does not implement the native dialog top layer; emulate only visibility.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
}
