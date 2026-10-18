import Link from "next/link";

/**
 * APL-2652 AC3. A missing task and a task the caller cannot see render this same page.
 * The id is not included, so the two responses do not reveal which one it was.
 */
export default function TaskNotFound() {
  return (
    <main id="main" tabIndex={-1} className="content">
      <div className="modal" style={{ margin: "0 auto" }}>
        <h2>This task isn&apos;t available</h2>
        <p className="sub">It may have been moved to Trash, or you may not be a member of its project.</p>
        <div className="actions"><Link className="btn" href="/">Go to My tasks</Link></div>
      </div>
    </main>
  );
}
