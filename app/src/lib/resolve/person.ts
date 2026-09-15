/**
 * Telling a person's name from a company's — EPA RMP operator fields.
 *
 * WHY THIS EXISTS — a measured defect, not a hypothetical one.
 *
 * `pick()` chose parentCompanyName, then operatorName, then facilityName. For
 * 263 active facilities there is no parent company, so the OPERATOR wins — and
 * the EPA operator field frequently holds the individual who signed the filing,
 * not a company. The result was people's names used as account names:
 *
 *     operatorName          facilityName (the actual company)
 *     Christopher Hawk  ->  Penske Logistics, LLC
 *     George Calhoon    ->  Magic Valley Fresh Frozen, Inc.
 *     Gary Crowder      ->  Smith Frozen Foods, INC
 *     Bradley Howard    ->  Suzanna's Kitchen, Inc.
 *
 * Two distinct harms. Named private individuals entered a prospect registry,
 * which gate G2 exists to prevent. And real companies were LOST: Penske
 * Logistics is named in INGESTION-GATES.md §9 #13 and was absent from the
 * registry purely because a person's name outranked it.
 *
 * The fix is not to reorder pick() globally. Measured: preferring facilityName
 * over operatorName everywhere gains 4 accounts and loses 21 — California
 * Dairies, National Beef Packing, Seneca Foods, Boar's Head and others, whose
 * facility names are site labels rather than companies. The operator field is
 * usually right. It is wrong in a specific, detectable way.
 */

/**
 * Words that mean "this is an organisation". Their presence is decisive: no
 * matter how much a name looks like `Firstname Lastname`, a business word
 * settles it.
 */
const BUSINESS_WORD =
  /\b(incorporated|inc|llc|ltd|lp|llp|corp|corporation|co|company|group|holdings?|farms?|foods?|storage|logistics|cold|warehouse|packing|meats?|dairy|dairies|market|markets|produce|fresh|frozen|services?|supply|industries|packers|cooperative|coop|distribution|transport|brands?|kitchen|provisions|cheese|beef|pork|poultry|seafood|grocer\w*|wholesale|terminal|plant|division|center|centre|intl|international|usa|america\w*|bakers?|chef|pure)\b/i;

/**
 * `Firstname Lastname` or `Firstname M. Lastname`, title-cased, nothing else.
 *
 * Deliberately strict. Requiring title case and exactly two or three tokens
 * keeps company names like "KOCH MEAT" and "SpartanNash Omaha" out, and the
 * middle-initial branch catches "Byron C. Russell".
 */
const PERSON_NAME = /^[A-Z][a-z]+(?: [A-Z]\.?)? [A-Z][a-z]+$/;

/**
 * Does this reported name look like an individual rather than an organisation?
 *
 * Pattern only — there is deliberately no dictionary of given names. A list
 * would be more precise (it would spare "Home Chef", "Universal Pure" and
 * "Valley Bakers", the three real companies this pattern misjudges) but it is a
 * shared word list that both implementations would have to keep identical
 * forever. Instead every firing is recorded in the review queue, so a
 * misjudgement is visible and a person can overturn it. Failing visibly beats
 * failing precisely.
 */
export function looksLikePerson(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (BUSINESS_WORD.test(trimmed)) return false;
  return PERSON_NAME.test(trimmed);
}

/**
 * Strip a trailing site qualifier from a facility name.
 *
 * Facility names identify a SITE, so they carry things a company name does not:
 * "Magic Valley Fresh Frozen, Inc. (Military)" and "… (Trophy)" are one company
 * at two plants. Left alone they key separately and the company splits in two.
 *
 * This matters here because the fix above makes facilityName load-bearing for
 * 47 facilities that previously resolved from the operator. Without it, fixing
 * the person-name bug would introduce an account split. It also un-splits two
 * companies that were already broken this way, Cheney Brothers and Eckert Cold
 * Storage.
 *
 * Only a TRAILING parenthetical is removed. Trailing numerals and Roman
 * numerals ("Suzanna's Kitchen II", "Joseph Cold Storage 1") split the same way
 * and are NOT handled — that is a broader normalisation question and guessing
 * at it would merge companies that are genuinely distinct.
 */
export function stripSiteQualifier(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return stripped.length > 0 ? stripped : name.trim();
}
