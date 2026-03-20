/**
 * Simple EventEmitter implementation for React Native
 * Provides basic event handling functionality without Node.js dependencies
 */

type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private events: Map<string, Listener[]> = new Map();

  on(event: string, listener: Listener): void {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event)!.push(listener);
  }

  off(event: string, listener: Listener): void {
    const listeners = this.events.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  emit(event: string, ...args: unknown[]): void {
    const listeners = this.events.get(event);
    if (listeners) {
      listeners.forEach(listener => listener(...args));
    }
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
    }
  }
}
