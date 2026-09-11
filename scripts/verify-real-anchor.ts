/** בדיקה: relayAuditVerify על-העיגון-האמת-שנשלף-מהשרשרת (e684f11e) */
import { relayAuditVerify } from "../src/lib/dex/relay";

const res = await relayAuditVerify("hive", "e684f11e37525844339b74eb67a755a024881ca1", {
  height: 30492,
  stateRoot: "98eaabfe890d4c70761a9e2893da00e2480271df9ff4861808fb8c9203e9e5c4",
  account: "headcorner",
});
console.log(JSON.stringify(res));
