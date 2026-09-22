// Reduced from packages/chord/src/services/wire.ts + state-codec.ts: the
// service-call and replicated-state wire shapes a transport-side client needs.
// Simplified: no WireOp interning (the reduced delta speaks plain Op[] on the
// wire), so the "decoder" is shape validation plus pass-through; ops are
// validated by apply on the consumer side.

import {
	applyImmutable,
	type JsonValue,
	type Op,
	type ServiceCall,
	type ServiceCatalogueEntry,
	type ServiceInstanceAddress,
	type ServiceInstanceSnapshot,
	type ServiceMode,
	type ServiceProviderUpdate,
	type ServiceSubscriptionSnapshot,
} from "../../chord/src/index.ts";

export type WireServiceMemberSnapshot =
	| { readonly name: string; readonly kind: "method" }
	| { readonly name: string; readonly kind: "state"; readonly sequence: number; readonly ops: readonly Op[] };

export type WireServiceInstanceSnapshot = {
	readonly instance?: ServiceInstanceAddress;
	readonly members: readonly WireServiceMemberSnapshot[];
};

export type WireServiceSubscriptionSnapshot = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	readonly instances: readonly WireServiceInstanceSnapshot[];
};

export type WireServiceProviderUpdate =
	| {
			readonly type: "state";
			readonly instance?: ServiceInstanceAddress;
			readonly member: string;
			readonly sequence: number;
			readonly ops: readonly Op[];
	  }
	| { readonly type: "unavailable" }
	| { readonly type: "replaced"; readonly snapshot: WireServiceInstanceSnapshot }
	| { readonly type: "spawned"; readonly instance: WireServiceInstanceSnapshot }
	| { readonly type: "closed"; readonly instance: ServiceInstanceAddress };

const SERVICE_CONTROL_ID = "$chord.service";
const SERVICE_CATALOGUE_MEMBER = "catalogue";
const SERVICE_SUBSCRIBE_MEMBER = "subscribe";
const SERVICE_UNSUBSCRIBE_MEMBER = "unsubscribe";

export function createServiceCatalogueCall(): ServiceCall {
	return { serviceId: SERVICE_CONTROL_ID, member: SERVICE_CATALOGUE_MEMBER, args: [] };
}

export function createServiceSubscribeCall(subscriptionId: string, serviceId: string, mode: ServiceMode): ServiceCall {
	return { serviceId: SERVICE_CONTROL_ID, member: SERVICE_SUBSCRIBE_MEMBER, args: [subscriptionId, serviceId, mode] };
}

export function createServiceUnsubscribeCall(subscriptionId: string): ServiceCall {
	return { serviceId: SERVICE_CONTROL_ID, member: SERVICE_UNSUBSCRIBE_MEMBER, args: [subscriptionId] };
}

export function parseServiceCall(value: unknown): ServiceCall {
	const call = record(value, "service call");
	assertKeys(call, ["serviceId", "member", "args"], ["instance"], "service call");
	if (!isId(call.serviceId) || !isId(call.member) || !Array.isArray(call.args)) {
		throw new TypeError("Invalid service call");
	}
	if (call.instance !== undefined) assertAddress(call.instance);
	return value as ServiceCall;
}

export function parseServiceCatalogue(value: unknown): readonly ServiceCatalogueEntry[] {
	if (!Array.isArray(value)) throw new TypeError("Invalid service catalogue");
	const ids = new Set<string>();
	for (const candidate of value) {
		const entry = record(candidate, "service catalogue entry");
		assertKeys(entry, ["serviceId", "mode"], [], "service catalogue entry");
		if (!isId(entry.serviceId) || !isMode(entry.mode) || ids.has(entry.serviceId)) {
			throw new TypeError("Invalid service catalogue");
		}
		ids.add(entry.serviceId);
	}
	return value as unknown as readonly ServiceCatalogueEntry[];
}

export function parseServiceSubscriptionSnapshot(value: unknown): ServiceSubscriptionSnapshot {
	assertSubscriptionSnapshot(value);
	return value as ServiceSubscriptionSnapshot;
}

export function parseWireServiceSubscriptionSnapshot(value: unknown): WireServiceSubscriptionSnapshot {
	assertSubscriptionSnapshot(value);
	return value as WireServiceSubscriptionSnapshot;
}

export function parseServiceProviderUpdate(value: unknown): ServiceProviderUpdate {
	assertProviderUpdate(value);
	return value as ServiceProviderUpdate;
}

export function parseWireServiceProviderUpdate(value: unknown): WireServiceProviderUpdate {
	assertProviderUpdate(value);
	return value as WireServiceProviderUpdate;
}

/**
 * Stateful per-subscription decoder. With no wire-op compression the reduced
 * decoder is shape validation plus pass-through; kept as a class so the client
 * reads the same as the original.
 */
export class ServiceStateDecoder {
	decodeSnapshot(snapshot: WireServiceSubscriptionSnapshot): ServiceSubscriptionSnapshot {
		return {
			serviceId: snapshot.serviceId,
			mode: snapshot.mode,
			instances: snapshot.instances.map((instance) => ({
				instance: instance.instance,
				members: instance.members.map((member) =>
					member.kind === "state"
						? { name: member.name, kind: "state", sequence: member.sequence, ops: member.ops }
						: { name: member.name, kind: "method" },
				),
			})),
		};
	}

	decodeUpdate(update: WireServiceProviderUpdate): ServiceProviderUpdate {
		return update as ServiceProviderUpdate;
	}
}

/** Factory kept for parity with the original chord state-codec API. */
export function createServiceStateDecoder(): ServiceStateDecoder {
	return new ServiceStateDecoder();
}

/** Applies one state update's ops to the previous value; returns the new immutable value. */
export function applyStateOps<T extends JsonValue>(previous: T | undefined, ops: readonly Op[]): T {
	return applyImmutable(previous, ops);
}

function assertSubscriptionSnapshot(value: unknown): void {
	const snapshot = record(value, "service subscription snapshot");
	assertKeys(snapshot, ["serviceId", "mode", "instances"], [], "service subscription snapshot");
	if (!isId(snapshot.serviceId) || !isMode(snapshot.mode) || !Array.isArray(snapshot.instances)) {
		throw new TypeError("Invalid service subscription snapshot");
	}
	for (const instance of snapshot.instances) assertInstance(instance);
}

function assertProviderUpdate(value: unknown): void {
	const update = record(value, "service provider update");
	if (update.type === "state") {
		assertKeys(update, ["type", "member", "sequence", "ops"], ["instance"], "state update");
		if (!isId(update.member) || !isInteger(update.sequence, 0) || !Array.isArray(update.ops)) {
			throw new TypeError("Invalid state update");
		}
		if (update.instance !== undefined) assertAddress(update.instance);
		return;
	}
	if (update.type === "unavailable") {
		assertKeys(update, ["type"], [], "unavailable update");
		return;
	}
	if (update.type === "replaced" || update.type === "spawned") {
		const key = update.type === "replaced" ? "snapshot" : "instance";
		assertKeys(update, ["type", key], [], "instance update");
		assertInstance(update[key]);
		return;
	}
	if (update.type === "closed") {
		assertKeys(update, ["type", "instance"], [], "closed update");
		assertAddress(update.instance);
		return;
	}
	throw new TypeError("Invalid service provider update");
}

function assertInstance(value: unknown): void {
	const instance = record(value, "service instance snapshot");
	assertKeys(instance, ["members"], ["instance"], "service instance snapshot");
	if (!Array.isArray(instance.members)) throw new TypeError("Invalid service instance snapshot");
	if (instance.instance !== undefined) assertAddress(instance.instance);
	for (const member of instance.members) {
		const entry = record(member, "service member snapshot");
		if (entry.kind === "method") {
			assertKeys(entry, ["name", "kind"], [], "method member snapshot");
			if (!isId(entry.name)) throw new TypeError("Invalid service member snapshot");
			continue;
		}
		if (entry.kind === "state") {
			assertKeys(entry, ["name", "kind", "sequence", "ops"], [], "state member snapshot");
			if (!isId(entry.name) || !isInteger(entry.sequence, 0) || !Array.isArray(entry.ops)) {
				throw new TypeError("Invalid service member snapshot");
			}
			continue;
		}
		throw new TypeError("Invalid service member snapshot");
	}
}

function assertAddress(value: unknown): asserts value is ServiceInstanceAddress {
	const address = record(value, "service instance address");
	assertKeys(address, ["key", "generation"], [], "service instance address");
	if (!isId(address.key) || !isInteger(address.generation, 0)) {
		throw new TypeError("Invalid service instance address");
	}
}

function record(value: unknown, description: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`Invalid ${description}`);
	}
	return value as Record<string, unknown>;
}

function assertKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	description: string,
): void {
	for (const key of required) {
		if (!(key in value)) throw new TypeError(`Invalid ${description}: missing ${key}`);
	}
	for (const key of Object.keys(value)) {
		if (!required.includes(key) && !optional.includes(key)) {
			throw new TypeError(`Invalid ${description}: unexpected ${key}`);
		}
	}
}

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isMode(value: unknown): value is ServiceMode {
	return value === "singleton" || value === "keyed";
}

function isInteger(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}
