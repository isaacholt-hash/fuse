import raw from "../../data/routing.json";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { checkPolicy, parsePolicy, type RoutingPolicy } from "./policy";

/** The routing policy shipped with the app, checked against the shipped catalog at startup. */
export const defaultPolicy: RoutingPolicy = parsePolicy(raw);

const problems = checkPolicy(defaultPolicy, defaultCatalog);
if (problems.length > 0) throw new Error(`data/routing.json: ${problems.join("; ")}`);
