import type { Sp } from "./fmt";
import { spStr } from "./fmt";

/** Standard err/ok banner fed by ?err= / ?ok= redirect params. */
export function Banner({ sp }: { sp: Sp }) {
  const err = spStr(sp, "err");
  const ok = spStr(sp, "ok");
  if (err !== "") return <div className="banner err">{err}</div>;
  if (ok !== "") return <div className="banner ok">{ok}</div>;
  return null;
}
