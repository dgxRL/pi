// Ported from packages/agent/test/utils/calculate.ts, adapted to the reduced
// contract (reduced AgentToolResult carries no images and no separate error type;
// evaluation failures propagate as thrown errors per the reduced tool contract).

import { Type, type Static } from "typebox";
import type { AgentTool } from "../../src/types.ts";

const calculateSchema = Type.Object({
	expression: Type.String({ description: "The mathematical expression to evaluate" }),
});

type CalculateParams = Static<typeof calculateSchema>;

export function calculate(expression: string): string {
	const result = new Function(`"use strict"; return (${expression})`)() as number;
	return `${expression} = ${result}`;
}

export const calculateTool: AgentTool<typeof calculateSchema, undefined> = {
	label: "Calculator",
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
	execute: async (_toolCallId: string, args: CalculateParams) => {
		return { content: [{ type: "text", text: calculate(args.expression) }], details: undefined };
	},
};
