import { formatUsd } from "@/cost/cost";

/** Integer micro-dollars → "$0.0093". */
export const money = (micro: number) => formatUsd(micro);
export const number = (amount: number) => amount.toLocaleString("en-US");
