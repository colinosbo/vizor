import { providerAdapters } from "./registry";
import { AppError } from "../server/errors";
export function getProvider(id: string) {
  const provider = providerAdapters.find((p) => p.id === id);
  if (!provider)
    throw new AppError(
      "provider_unsupported",
      "This provider is not available.",
      404,
    );
  return provider;
}
export const providers = providerAdapters;
