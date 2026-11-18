import { jsonRoute } from "../../../../src/server/http.ts";
import { addOwnedMediaToCollection } from "../../../../src/server/handlers/collections.ts";

export const POST = jsonRoute(addOwnedMediaToCollection);
