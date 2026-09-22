// Reduced from packages/client/src/unix.ts: the concrete Unix-socket byte
// transport. Dropped: server discovery (probe workers + timeout error
// taxonomy) and Windows guards; write drain bookkeeping simplified to the
// write callback (ordering still preserved by a serialized write tail).

import { createConnection, type Socket } from "node:net";
import { DEFAULT_MAX_FRAME_LENGTH } from "../../protocol/src/index.ts";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

export interface UnixTransportOptions {
	path: string;
}

/** Creates fresh Unix-domain socket transports for Client connection attempts. */
export function createUnixTransportFactory(options: UnixTransportOptions): ByteTransportFactory {
	if (options.path.length === 0) throw new TypeError("Unix transport path must not be empty");
	return (handlers) => connectUnixSocket(options.path, handlers);
}

function connectUnixSocket(path: string, handlers: ByteTransportHandlers): Promise<ByteTransport> {
	return new Promise<ByteTransport>((resolve, reject) => {
		const socket = createConnection(path);
		let connected = false;
		let terminal = false;

		const close = (): void => {
			if (terminal) return;
			terminal = true;
			socket.destroy();
			if (connected) handlers.onClose();
			else reject(new Error("Unix transport closed before connecting"));
		};

		socket.once("connect", () => {
			if (terminal) return;
			connected = true;
			resolve(new UnixByteTransport(socket));
		});
		socket.on("data", (chunk) => {
			if (!terminal) handlers.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		socket.once("end", close);
		socket.once("close", close);
		socket.once("error", (error) => {
			if (terminal) return;
			terminal = true;
			socket.destroy();
			if (connected) handlers.onError(error);
			else reject(error);
		});
	});
}

class UnixByteTransport implements ByteTransport {
	readonly #socket: Socket;
	#closed = false;
	#writeTail: Promise<void> = Promise.resolve();

	constructor(socket: Socket) {
		this.#socket = socket;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("Unix transport chunks must be Uint8Array"));
		}
		if (this.#closed) return Promise.reject(new Error("Unix transport is closed"));
		// Serialize writes so chunks reach the socket in invocation order.
		const bytes = chunk.slice();
		const write = this.#writeTail.then(() => this.#write(bytes));
		this.#writeTail = write.catch(() => {});
		return write;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.destroy();
	}

	#write(chunk: Uint8Array): Promise<void> {
		if (this.#closed || !this.#socket.writable) return Promise.reject(new Error("Unix transport is closed"));
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#socket.write(chunk, (error) => {
			if (error) reject(error);
			else resolve();
		});
		return promise;
	}
}

/** Default pending-byte budget kept for API parity with the original options. */
export const DEFAULT_MAX_PENDING_BYTES = DEFAULT_MAX_FRAME_LENGTH * 4;
