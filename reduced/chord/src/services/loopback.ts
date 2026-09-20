import type {
	Context,
	JsonValue,
	RemoteServiceTransport,
	ServiceCall,
	ServiceMode,
	ServiceProviderUpdate,
	ServiceSubscription,
} from "../types.ts";

/** The serving surface any loopback-able provider exposes. */
export interface ServiceProviderServing {
	invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined>;
	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
		context?: Context,
	): ServiceSubscription | Promise<ServiceSubscription>;
}

/** Connects a provider to a binding without changing remote service semantics. */
export function createLoopbackServiceTransport(provider: ServiceProviderServing): RemoteServiceTransport {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		subscribe: async (serviceId, mode, listener, context) => {
			const subscription = await provider.subscribe(serviceId, mode, listener, context);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}
