import { anthropic } from "./anthropic";
import { AppError } from "../server/errors";
export function getProvider(id: string) {
  if (id !== anthropic.id)
    throw new AppError(
      "provider_unsupported",
      "This provider is not available in stage one.",
      404,
    );
  return anthropic;
}
