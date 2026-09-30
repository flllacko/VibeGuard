import { z } from "zod";
import { RefSchema } from "./task-registry.js";

export const VerifyTaskInputSchema = z.object({ taskRef: RefSchema.optional(), scope: z.enum(["checkpoint", "final"]).default("checkpoint"), forceRerun: z.boolean().default(false) }).strict();
