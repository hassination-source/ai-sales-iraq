import "server-only";
import { cookies } from "next/headers";

export type Lang = "ar" | "en";

export async function getLang(): Promise<Lang> {
  const v = (await cookies()).get("lang")?.value;
  return v === "en" ? "en" : "ar";
}

const dict = {
  appName: { ar: "مبيعات العراق", en: "Sales Iraq" },
  nav: {
    dashboard: { ar: "نظرة عامة", en: "Overview" },
    leads: { ar: "العملاء المحتملون", en: "Leads" },
    pipeline: { ar: "مسار المبيعات", en: "Pipeline" },
    import: { ar: "استيراد", en: "Import" },
    signOut: { ar: "تسجيل الخروج", en: "Sign out" },
    switchLang: { ar: "English", en: "العربية" },
  },
  auth: {
    title: { ar: "ادخل إلى حساب شركتك", en: "Sign in to your company" },
    signupTitle: { ar: "أنشئ حساباً جديداً", en: "Create an account" },
    email: { ar: "البريد الإلكتروني", en: "Email" },
    password: { ar: "كلمة المرور", en: "Password" },
    signIn: { ar: "تسجيل الدخول", en: "Sign in" },
    signUp: { ar: "إنشاء الحساب", en: "Create account" },
    toSignup: { ar: "ليس لديك حساب؟ أنشئ حساباً", en: "No account? Create one" },
    toSignin: { ar: "لديك حساب؟ سجّل الدخول", en: "Have an account? Sign in" },
    checkEmail: { ar: "أرسلنا رابط التفعيل إلى بريدك. افتحه ثم سجّل الدخول.", en: "We sent a confirmation link to your email. Open it, then sign in." },
    badLogin: { ar: "البريد أو كلمة المرور غير صحيحة.", en: "Email or password is incorrect." },
    weakPassword: { ar: "كلمة المرور يجب أن تكون 8 أحرف على الأقل.", en: "Password must be at least 8 characters." },
  },
  onboarding: {
    title: { ar: "عرّفنا بشركتك", en: "Set up your company" },
    intro: { ar: "اختر قطاعك وسنجهّز مراحل البيع ومعايير التأهيل المناسبة له. يمكنك تعديلها لاحقاً.", en: "Pick your industry and we'll set up the matching sales stages and qualification criteria. You can change them later." },
    name: { ar: "اسم الشركة", en: "Company name" },
    industry: { ar: "القطاع", en: "Industry" },
    currency: { ar: "العملة الافتراضية", en: "Default currency" },
    territories: { ar: "المحافظات التي تبيع فيها", en: "Governorates you sell in" },
    create: { ar: "إنشاء الشركة", en: "Create company" },
    slugTaken: { ar: "هذا الاسم مستخدم. جرّب اسماً آخر.", en: "That name is taken. Try another." },
  },
  common: {
    unknown: { ar: "غير معروف", en: "Unknown" },
    save: { ar: "حفظ", en: "Save" },
    cancel: { ar: "إلغاء", en: "Cancel" },
    none: { ar: "لا يوجد", en: "None" },
    yes: { ar: "نعم", en: "Yes" },
    no: { ar: "لا", en: "No" },
    all: { ar: "الكل", en: "All" },
  },
} as const;

type Leaf = { ar: string; en: string };
type Tree = { [k: string]: Leaf | Tree };

/** Translator bound to a language: tr("auth.signIn") */
export function translator(lang: Lang) {
  return (path: string): string => {
    let node: Leaf | Tree = dict as unknown as Tree;
    for (const part of path.split(".")) node = (node as Tree)[part] as Leaf | Tree;
    return (node as Leaf)?.[lang] ?? path;
  };
}

export const fmtNumber = (lang: Lang, n: number) => new Intl.NumberFormat(lang === "ar" ? "ar-IQ" : "en-US").format(n);
export const fmtMoney = (lang: Lang, n: number, currency: string) =>
  new Intl.NumberFormat(lang === "ar" ? "ar-IQ" : "en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
export const fmtDate = (lang: Lang, d: string | Date) =>
  new Intl.DateTimeFormat(lang === "ar" ? "ar-IQ" : "en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(d));
