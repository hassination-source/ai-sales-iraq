import { definePack } from "../pack";

/**
 * Automotive parts distribution (B2B to workshops, dealers and fleets).
 * Second pack: proves a different funnel, fields and scoring work with
 * zero changes to the core platform.
 */
export const autoPartsPack = definePack({
  id: "auto-parts",
  version: 1,
  name: { ar: "توزيع قطع غيار السيارات", en: "Auto parts distribution" },
  description: {
    ar: "بيع قطع الغيار بالجملة للورش والوكلاء وأساطيل النقل",
    en: "Wholesale parts to workshops, dealers and fleet operators",
  },
  segments: [
    { key: "workshop", label: { ar: "ورش تصليح", en: "Repair workshops" }, painPoints: [{ ar: "تأخر توفر القطع", en: "Slow parts availability" }] },
    { key: "parts_retailer", label: { ar: "محلات قطع غيار", en: "Parts retailers" } },
    { key: "fleet", label: { ar: "أساطيل نقل وشركات", en: "Fleet operators" }, painPoints: [{ ar: "توقف المركبات عن العمل", en: "Vehicle downtime" }] },
    { key: "dealer", label: { ar: "وكلاء سيارات", en: "Car dealers" } },
  ],
  companyFields: [
    {
      key: "segment",
      label: { ar: "القطاع", en: "Segment" },
      type: "enum",
      options: [
        { value: "workshop", label: { ar: "ورشة", en: "Workshop" } },
        { value: "parts_retailer", label: { ar: "محل قطع", en: "Retailer" } },
        { value: "fleet", label: { ar: "أسطول", en: "Fleet" } },
        { value: "dealer", label: { ar: "وكيل", en: "Dealer" } },
      ],
    },
    { key: "fleet_size", label: { ar: "عدد المركبات", en: "Fleet size" }, type: "number", min: 0 },
    { key: "brands_serviced", label: { ar: "الماركات", en: "Brands serviced" }, type: "text" },
  ],
  qualificationFields: [
    { key: "monthly_volume_usd", label: { ar: "حجم الشراء الشهري التقديري", en: "Estimated monthly volume" }, type: "number", unit: "USD", min: 0 },
    {
      key: "payment_terms",
      label: { ar: "شروط الدفع", en: "Payment terms" },
      type: "enum",
      options: [
        { value: "cash", label: { ar: "نقداً", en: "Cash" } },
        { value: "net_30", label: { ar: "آجل 30 يوم", en: "Net 30" } },
        { value: "consignment", label: { ar: "أمانة", en: "Consignment" } },
      ],
    },
    { key: "sample_order_placed", label: { ar: "تم طلب عينة", en: "Sample order placed" }, type: "boolean" },
  ],
  stages: [
    { key: "prospect", label: { ar: "محتمل", en: "Prospect" } },
    { key: "visited", label: { ar: "تمت الزيارة", en: "Visited" }, probability: 20 },
    { key: "trial_order", label: { ar: "طلب تجريبي", en: "Trial order" }, probability: 50, requires: ["sample_order_placed"] },
    { key: "account_opened", label: { ar: "تم فتح حساب", en: "Account opened" }, kind: "won", probability: 100, requires: ["payment_terms"] },
    { key: "not_interested", label: { ar: "غير مهتم", en: "Not interested" }, kind: "lost", probability: 0 },
  ],
  scoring: [
    { key: "big_fleet", when: { field: "attributes.fleet_size", op: "gte", value: 20 }, points: 30, reason: { ar: "أسطول كبير", en: "Large fleet" } },
    { key: "workshop", when: { field: "attributes.segment", op: "in", value: ["workshop", "parts_retailer"] }, points: 20, reason: { ar: "مشترٍ متكرر", en: "Repeat buyer segment" } },
    { key: "in_territory", when: { field: "governorate", op: "in_territory" }, points: 15, reason: { ar: "ضمن منطقة التوزيع", en: "In distribution area" } },
  ],
  languages: ["ar-IQ", "en"],
  channels: ["phone", "whatsapp", "in_person"],
  ai: {
    neverInvent: [
      { ar: "توفر القطع أو أسعارها أو مواعيد التسليم", en: "Part availability, prices or delivery times" },
      { ar: "التوافق مع موديل معين إلا من الكتالوج", en: "Vehicle fitment except from the catalog" },
    ],
    escalateOn: [{ ar: "طلب حد ائتمان", en: "Credit limit requests" }],
  },
});
