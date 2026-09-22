// Reduced from packages/chord/src/types.ts (261 lines). Dropped: the
// RemoteServiceContract conditional-type machinery, JsonRepresentation, and
// RemoteServiceSource (multi-source facet hosts). Everything else is the real
// contract. Op comes from the delta protocol.

import type { Op } from "./delta.ts";

/** Typed identity for one value carried by a {@link Context}. */
export interface ContextKey<T> {
	readonly token: symbol;
	/** Type-only marker that prevents keys with different value types from being interchangeable. */
	readonly valueType?: (value: T) => T;
}

/** Immutable invocation-scoped values passed explicitly through operations. */
export interface Context {
	readonly abortSignal: AbortSignal | undefined;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ReplicatedStateDelivery {
	readonly kind: "hydrate" | "update";
	readonly sequence: number;
}

export interface ReplicatedState<T> {
	/** Immutable value, or undefined until hydration. Later updates do not mutate previously returned values. */
	readonly value: T | undefined;
	/** Listener values are immutable and may structurally share unchanged data with other revisions. */
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void;
}

export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
	readonly value: T;
	/** Mutable tracked state. All writes must go through this proxy. */
	readonly state: T;
	/** Publish the changes made through {@link state} since the previous publication. */
	publish(context: Context): void;
}

declare const SERVICE_TYPE: unique symbol;

export type ServiceMode = "singleton" | "keyed";

/** Stable identity for one shared TypeScript service contract. */
export interface Service<T> {
	readonly id: string;
	/** Process-local services are never published remotely. */
	readonly local: boolean;
	readonly [SERVICE_TYPE]?: (value: T) => T;
}

export interface ServiceSpawner<T> {
	spawn(key: string, implementation: T): () => void;
}

export interface RemoteServices {
	use<T>(service: Service<T>): T;
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void;
	/** Wait until every currently acquired service has installed its initial snapshot. */
	ready(context: Context): Promise<void>;
	dispose(context: Context): Promise<void>;
}

export type ServiceCatalogueEntry = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
};

export type ServiceInstanceAddress = {
	readonly key: string;
	readonly generation: number;
};

export type ServiceMemberSnapshot =
	| { readonly name: string; readonly kind: "method" }
	| { readonly name: string; readonly kind: "state"; readonly sequence: number; readonly ops: readonly Op[] };

export type ServiceInstanceSnapshot = {
	readonly instance?: ServiceInstanceAddress;
	readonly members: readonly ServiceMemberSnapshot[];
};

export type ServiceSubscriptionSnapshot = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	readonly instances: readonly ServiceInstanceSnapshot[];
};

export type ServiceProviderUpdate =
	| {
			readonly type: "state";
			readonly instance?: ServiceInstanceAddress;
			readonly member: string;
			readonly sequence: number;
			readonly ops: readonly Op[];
	  }
	| { readonly type: "unavailable" }
	| { readonly type: "replaced"; readonly snapshot: ServiceInstanceSnapshot }
	| { readonly type: "spawned"; readonly instance: ServiceInstanceSnapshot }
	| { readonly type: "closed"; readonly instance: ServiceInstanceAddress };

export type ServiceCall = {
	readonly serviceId: string;
	readonly instance?: ServiceInstanceAddress;
	readonly member: string;
	/** Borrowed immutable values. Chord validates but does not clone them. */
	readonly args: readonly JsonValue[];
};

export interface ServiceSubscription {
	readonly snapshot: ServiceSubscriptionSnapshot;
	activate(): void;
	close(context?: Context): void | Promise<void>;
}

/**
 * Pluggable wire boundary consumed by a remote service binding.
 * Implementations choose transport, framing, and routing; the reduced copy
 * ships one in-process loopback implementation.
 */
export interface RemoteServiceTransport {
	invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined>;
	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
		context: Context,
	): Promise<ServiceSubscription>;
}

export interface RemoteServiceBindingOptions {
	readonly services: readonly { readonly id: string }[];
	readonly transport: RemoteServiceTransport;
	readonly bound?: boolean;
	readonly onError?: (error: Error) => void;
}

export interface RemoteServiceBinding extends RemoteServices {
	rebind(bound: boolean, context: Context): Promise<void>;
}

export interface FacetEnvironment {
	/** Declare a hard dependency on one singleton service and return its stable handle. */
	use<T>(service: Service<T>): T;
	/** Declare a hard dependency on a keyed service and observe each live instance. */
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): void;
	/** Declare and install this facet's singleton implementation of a service. */
	provide<T>(service: Service<T>, implementation: NoInfer<T>): void;
	/** Declare ownership of a multi-instance service and return its deferred spawning capability. */
	provideMany<T>(service: Service<T>): ServiceSpawner<T>;
	/** Create initialized mutable state suitable for exposing through a service implementation. */
	replicatedState<T extends object>(initial: T): MutableReplicatedState<T>;
	/** Give the facet ownership of a resource cleanup function. */
	own(disposal: () => void | Promise<void>): void;
	/** Register asynchronous initialization after dependencies are bound and ready. */
	onActivate(callback: () => void | Promise<void>): void;
	/** Register final facet teardown. */
	onDeactivate(callback: () => void | Promise<void>): void;
}

export interface Facet {
	readonly id: string;
	setup(env: FacetEnvironment): void;
}

export interface FacetOptions {
	readonly facets: readonly Facet[];
	readonly onError?: (error: Error) => void;
}

export interface FacetHost {
	/** Local consumption plus the serving side (invoke/subscribe) for transports. */
	readonly services: RemoteServices & RemoteServiceTransport;
	/** Activate and replace facets with matching IDs without disconnecting consumer service handles. */
	reload(facets: readonly Facet[]): Promise<void>;
	dispose(): Promise<void>;
}

export interface LoadedFacets {
	readonly facets: readonly Facet[];
	dispose(): Promise<void>;
}

export interface FacetLoader {
	load(): Promise<LoadedFacets>;
}
