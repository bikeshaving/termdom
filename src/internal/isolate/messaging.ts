import {queueTask} from "./timers.ts";

interface Win {
	EventTarget: new () => EventTarget;
	MessageEvent: new (type: string, init?: MessageEventInit) => Event;
}

interface PortState {
	other: PortState | null;
	port: EventTarget;
	queue: unknown[];
	started: boolean;
	closed: boolean;
	handler: ((event: Event) => void) | null;
}

export function createMessageChannel(win: Win): {
	MessageChannel: new () => {port1: EventTarget; port2: EventTarget};
	MessagePort: new () => EventTarget;
} {
	const states = new WeakMap<object, PortState>();
	const state = (port: object): PortState => {
		const found = states.get(port);
		if (found === undefined) {
			throw new TypeError("Illegal invocation");
		}

		return found;
	};

	const deliver = (target: PortState): void => {
		if (!target.started || target.closed) {
			return;
		}

		for (const data of target.queue.splice(0)) {
			queueTask(() => {
				if (!target.closed) {
					target.port.dispatchEvent(new win.MessageEvent("message", {data}));
				}
			});
		}
	};

	let constructing = false;

	class MessagePort extends win.EventTarget {
		constructor() {
			if (!constructing) {
				throw new TypeError("Illegal constructor");
			}

			super();
			states.set(this, {
				other: null,
				port: this,
				queue: [],
				started: false,
				closed: false,
				handler: null,
			});
		}

		get onmessage(): ((event: Event) => void) | null {
			return state(this).handler;
		}

		set onmessage(handler: ((event: Event) => void) | null) {
			const own = state(this);
			if (own.handler !== null) {
				this.removeEventListener("message", own.handler);
			}

			own.handler = typeof handler === "function" ? handler : null;
			if (own.handler !== null) {
				this.addEventListener("message", own.handler);
				this.start();
			}
		}

		postMessage(message: unknown): void {
			const own = state(this);
			if (own.closed || own.other === null || own.other.closed) {
				return;
			}

			own.other.queue.push(structuredClone(message));
			deliver(own.other);
		}

		start(): void {
			const own = state(this);
			own.started = true;
			deliver(own);
		}

		close(): void {
			const own = state(this);
			own.closed = true;
			own.queue.length = 0;
		}
	}

	class MessageChannel {
		readonly port1: MessagePort;
		readonly port2: MessagePort;

		constructor() {
			constructing = true;
			try {
				this.port1 = new MessagePort();
				this.port2 = new MessagePort();
			} finally {
				constructing = false;
			}

			const one = state(this.port1);
			const two = state(this.port2);
			one.other = two;
			two.other = one;
		}
	}

	return {MessageChannel, MessagePort};
}
