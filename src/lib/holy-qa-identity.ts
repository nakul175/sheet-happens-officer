/** Deliberate isolated QA RP. Never derives origins/client IDs from a request. */
export function holyQaIdentity(env: Record<string, string | undefined> = process.env) {
    if (env.SHO_HOLY_QA !== '1')
        return null;
    if (env.APP_URL !== 'https://sho-qa.aplyd.org')
        throw Error('QA identity requires the exact isolated staging origin');
    const subjects = (env.SHO_HOLY_QA_SUBJECTS ?? '').split(',');
    if (!subjects.length || subjects.length > 4 || subjects.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) || new Set(subjects).size !== subjects.length)
        throw Error('Explicit QA identity allowlist required');
    return { origin: 'https://sho-qa.aplyd.org', clientId: 'sho-holy-qa', subjects };
}
export function centralIdentitySecret(env: Record<string, string | undefined> = process.env) {
    const value = holyQaIdentity(env) ? env.SHO_HOLY_QA_CLIENT_SECRET : env.APLYD_ACCOUNTS_CLIENT_SECRET;
    if (!value || value.length < 32)
        throw Error('Central login not configured');
    return value;
}
