/** Chord reduced: a standalone application-composition runtime for agentic applications. */
export {
	combineFacetLoaders,
	createFacetHost,
	createRemoteServiceBinding,
	createStaticFacetLoader,
	defineFacet,
	defineService,
	replicatedState,
} from "./api.ts";
export {
	apply,
	applyImmutable,
	isBase,
	isReplace,
	track,
	PathError,
	type Op,
	type Path,
	type Tracker,
} from "./delta.ts";
export {
	isRemoteServiceErrorCode,
	REMOTE_SERVICE_ERROR_CODES,
	RemoteServiceError,
	type RemoteServiceErrorCode,
} from "./services/errors.ts";
export { createLoopbackServiceTransport } from "./services/loopback.ts";
export * from "./context.ts";
export type {
	Context,
	ContextKey,
	Facet,
	FacetEnvironment,
	FacetHost,
	FacetLoader,
	FacetOptions,
	JsonValue,
	LoadedFacets,
	MutableReplicatedState,
	RemoteServiceBinding,
	RemoteServiceBindingOptions,
	RemoteServiceTransport,
	ReplicatedState,
	ReplicatedStateDelivery,
	Service,
	ServiceCall,
	ServiceCatalogueEntry,
	ServiceInstanceAddress,
	ServiceInstanceSnapshot,
	ServiceMemberSnapshot,
	ServiceProviderUpdate,
	ServiceMode,
	ServiceSpawner,
	ServiceSubscription,
	ServiceSubscriptionSnapshot,
} from "./types.ts";
