import { jsonRoute } from "../../../../src/server/http.ts";
import { removeCollectionItem } from "../../../../src/server/handlers/collections.ts";

// Removes only the selected CollectionItem association; it never invokes media deletion.
export const POST = jsonRoute(removeCollectionItem);
