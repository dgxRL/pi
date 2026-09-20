// Reduced from packages/ai/src/models.ts (966 lines). No provider factories,
// no auth plumbing, no catalog persistence: one map from provider id to
// { models, stream }. `stream`/`complete` dispatch on the model's provider.

import type { AssistantMessage, Context, Model, StreamFunction, StreamOptions } from "./types.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";

interface ProviderRegistration {
	models: Model[];
	stream: StreamFunction;
}

const providers = new Map<string, ProviderRegistration>();

export function registerProvider(registration: {
	id: string;
	models: Model[];
	stream: StreamFunction;
}): void {
	providers.set(registration.id, { models: registration.models, stream: registration.stream });
}

export function unregisterProvider(id: string): void {
	providers.delete(id);
}

export function getProviders(): string[] {
	return [...providers.keys()];
}

export function getModels(provider?: string): Model[] {
	if (provider !== undefined) return providers.get(provider)?.models ?? [];
	return [...providers.values()].flatMap((entry) => entry.models);
}

export function getModel(provider: string, id: string): Model | undefined {
	return providers.get(provider)?.models.find((model) => model.id === id);
}

function providerFor(model: Model): ProviderRegistration {
	const registration = providers.get(model.provider);
	if (registration === undefined) throw new Error(`Unknown provider: ${model.provider}`);
	return registration;
}

/** Starts a stream for one model. Errors terminate inside the stream. */
export function stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream {
	return providerFor(model).stream(model, context, options);
}

/** Completes one turn: streams and awaits the final AssistantMessage. */
export async function complete(model: Model, context: Context, options?: StreamOptions): Promise<AssistantMessage> {
	return stream(model, context, options).result();
}
