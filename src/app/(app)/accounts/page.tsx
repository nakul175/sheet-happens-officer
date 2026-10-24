import AccountsView from "./AccountsView";
export const metadata = { title: "Accounts · Sheet Happens Officer" };

function one(v: string | string[] | undefined) {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** The query is read on the server, so the first paint is the accounts page and not an empty suspense hole. */
export default async function Page({ searchParams }: PageProps<"/accounts">) {
  const sp = await searchParams;
  return <AccountsView initialQuery={one(sp.q)} initialKind={one(sp.kind)} />;
}
