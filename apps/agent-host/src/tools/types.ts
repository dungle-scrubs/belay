/** A tool the model can call: a name + JSON-Schema parameters, and an executor. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}
