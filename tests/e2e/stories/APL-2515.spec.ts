// SHO-US-8.6 Speak to the concierge (APL-2515).
// One test per acceptance criterion. No message is sent, so none of these call the model.
// A stand-in speech engine (helpers/jim-concierge.ts armDictation) stands in for a browser that can dictate.
// The unsupported check uses the test browser as it is, and skips if that browser already has speech recognition.
import { test, expect } from "../support";
import { armDictation, requireModel, setDictation, showConcierge, startDictation } from "../helpers/jim-concierge";
import { chatMessages } from "../helpers/jim-http";

test.use({ viewport: { width: 1440, height: 900 } });

async function dock(who: { page: import("@playwright/test").Page }) {
  await who.page.goto("/");
  await expect(who.page.locator("aside.cc-slot textarea")).toBeVisible();
}

test("AC1: dictation fills the input and sends nothing until Send", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await armDictation(admin.page);
  await dock(admin);
  await setDictation(admin.page, "speak");
  const before = (await chatMessages(admin)).length;
  await startDictation(admin);
  await expect(admin.page.getByText("Listening")).toBeVisible();
  await admin.page.getByRole("button", { name: "Done" }).click();
  await expect(admin.page.getByLabel("Message the concierge")).toHaveValue(/ZZ-TEST dictate/);
  expect((await chatMessages(admin)).length).toBe(before);
});

test("AC2: a browser without speech recognition shows no microphone, and typing still works", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await dock(admin);
  const supported = await admin.page.evaluate(() => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
  });
  test.skip(supported, "This browser already has speech recognition, so it shows the microphone. The hidden-microphone state is what a browser without the API shows.");
  await expect(admin.page.locator("button.cc-mic")).toHaveCount(0);
  await admin.page.getByLabel("Message the concierge").fill("ZZ-TEST typed");
  await expect(admin.page.getByLabel("Message the concierge")).toHaveValue("ZZ-TEST typed");
});

test("AC3: a denied microphone explains how to allow it, and typing still works", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await armDictation(admin.page);
  await dock(admin);
  await setDictation(admin.page, "denied");
  const before = (await chatMessages(admin)).length;
  await startDictation(admin);
  await expect(admin.page.locator("aside.cc-slot .err")).toContainText(/microphone is blocked/i);
  await expect(admin.page.locator("aside.cc-slot .err")).toContainText(/allow microphone/i);
  await admin.page.getByLabel("Message the concierge").fill("ZZ-TEST still typing");
  await expect(admin.page.getByLabel("Message the concierge")).toHaveValue("ZZ-TEST still typing");
  expect((await chatMessages(admin)).length).toBe(before);
});

test("AC4: the first use of the microphone shows the speech-service notice, and Got it is remembered", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await armDictation(admin.page);
  await dock(admin);
  await setDictation(admin.page, "hold");
  const acked = !!(await admin.api.get("/api/concierge/state")).json.voiceNoticeAcked;
  const mic = admin.page.locator("button.cc-mic");
  const notice = admin.page.getByRole("alertdialog", { name: "About dictation" });
  if (!acked) {
    await mic.click();
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/browser's speech service/i);
    await expect(admin.page.getByText("Listening")).toHaveCount(0);
    await notice.getByRole("button", { name: "Got it" }).click();
    await expect(admin.page.getByText("Listening")).toBeVisible();
    await admin.page.getByRole("button", { name: "Cancel" }).click();
  } else {
    test.info().annotations.push({ type: "remembered", description: "This account already tapped Got it, so the first-use notice cannot be shown again. This run checks that it stays hidden." });
  }
  await mic.click();
  await expect(notice).toHaveCount(0);
  await expect(admin.page.getByText("Listening")).toBeVisible();
  await admin.page.getByRole("button", { name: "Cancel" }).click();
});

test("AC5: recording stops after 60 seconds or on silence and keeps the transcript; Cancel adds nothing", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await armDictation(admin.page);
  await dock(admin);
  await admin.page.clock.install();
  await setDictation(admin.page, "silence", "ZZ-TEST silence");
  await startDictation(admin);
  await admin.page.clock.fastForward(500);
  await expect(admin.page.getByLabel("Message the concierge")).toHaveValue(/ZZ-TEST silence/);
  await admin.page.getByLabel("Message the concierge").fill("");
  await setDictation(admin.page, "hold", "ZZ-TEST held");
  await admin.page.locator("button.cc-mic").click();
  await admin.page.clock.fastForward(500);
  await expect(admin.page.getByText("Listening")).toBeVisible();
  await admin.page.getByRole("button", { name: "Cancel" }).click();
  await expect(admin.page.getByLabel("Message the concierge")).toHaveValue("");
  await admin.page.locator("button.cc-mic").click();
  await admin.page.clock.fastForward(500);
  await expect(admin.page.getByText("Listening")).toBeVisible();
  await admin.page.clock.fastForward(60_000);
  await expect(admin.page.getByLabel("Message the concierge")).toHaveValue(/ZZ-TEST held/);
  await expect(admin.page.getByText("Listening")).toHaveCount(0);
});

test("AC6: dictation is set to English (India)", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await armDictation(admin.page);
  await dock(admin);
  await setDictation(admin.page, "hold");
  await startDictation(admin);
  await expect(admin.page.getByText("Listening")).toBeVisible();
  const lang = await admin.page.evaluate(() => (window as unknown as { __shoDict?: { lang: string } }).__shoDict?.lang);
  expect(lang).toBe("en-IN");
  await admin.page.getByRole("button", { name: "Cancel" }).click();
});
