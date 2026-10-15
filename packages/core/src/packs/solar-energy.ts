import { definePack } from "../pack";

/**
 * Solar PV / BESS for commercial & industrial customers in Iraq.
 * First proof of concept: Sigen Solar Energy (Sigenergy distributor).
 * Contains NO product specifications or prices — those come only from the
 * tenant's knowledge base. Pain points are hypotheses to verify per prospect.
 */
export const solarEnergyPack = definePack({
  id: "solar-energy",
  version: 1,
  name: { ar: "الطاقة الشمسية وتخزين الطاقة", en: "Solar energy & storage" },
  description: {
    ar: "بيع أنظمة الطاقة الشمسية والبطاريات والإنفرترات للقطاع التجاري والصناعي",
    en: "Selling solar PV, battery storage and inverters to commercial and industrial customers",
  },
  segments: [
    {
      key: "factory",
      label: { ar: "مصانع ومنشآت صناعية", en: "Factories & industrial facilities" },
      painPoints: [
        { ar: "تكلفة وقود المولدات", en: "Generator fuel cost" },
        { ar: "انقطاع الكهرباء يوقف الإنتاج", en: "Grid outages stop production" },
      ],
    },
    { key: "hotel", label: { ar: "فنادق", en: "Hotels" }, painPoints: [{ ar: "الحاجة لكهرباء مستمرة للنزلاء", en: "Need for uninterrupted power for guests" }] },
    { key: "hospital", label: { ar: "مستشفيات ومراكز صحية", en: "Hospitals & clinics" }, painPoints: [{ ar: "أجهزة حرجة تحتاج طاقة احتياطية", en: "Critical equipment needs backup power" }] },
    { key: "commercial_building", label: { ar: "مبانٍ تجارية", en: "Commercial buildings" } },
    { key: "education", label: { ar: "مدارس وجامعات", en: "Schools & universities" } },
    { key: "retail", label: { ar: "مولات ومطاعم وسلاسل تجارية", en: "Malls, restaurants & retail chains" } },
    { key: "real_estate", label: { ar: "مطورون عقاريون وشركات إنشاء", en: "Real-estate developers & construction" } },
    { key: "agriculture", label: { ar: "مشاريع زراعية", en: "Agricultural businesses" }, painPoints: [{ ar: "ضخ المياه في مناطق بعيدة عن الشبكة", en: "Water pumping far from the grid" }] },
    { key: "channel_partner", label: { ar: "مقاولو EPC وكهربائيون وموزعون", en: "EPC contractors, installers & resellers" } },
  ],
  companyFields: [
    {
      key: "segment",
      label: { ar: "القطاع", en: "Segment" },
      type: "enum",
      options: [
        { value: "factory", label: { ar: "مصنع", en: "Factory" } },
        { value: "hotel", label: { ar: "فندق", en: "Hotel" } },
        { value: "hospital", label: { ar: "مستشفى", en: "Hospital" } },
        { value: "commercial_building", label: { ar: "مبنى تجاري", en: "Commercial building" } },
        { value: "education", label: { ar: "تعليم", en: "Education" } },
        { value: "retail", label: { ar: "تجزئة", en: "Retail" } },
        { value: "real_estate", label: { ar: "عقارات", en: "Real estate" } },
        { value: "agriculture", label: { ar: "زراعة", en: "Agriculture" } },
        { value: "channel_partner", label: { ar: "شريك/مقاول", en: "Channel partner" } },
      ],
    },
    { key: "uses_diesel_generator", label: { ar: "يستخدم مولدة ديزل", en: "Uses diesel generator" }, type: "boolean" },
    { key: "grid_hours_per_day", label: { ar: "ساعات الكهرباء الوطنية يومياً", en: "Grid hours per day" }, type: "number", unit: "h", min: 0, max: 24 },
    { key: "roof_or_land_area_m2", label: { ar: "مساحة السطح أو الأرض", en: "Roof or land area" }, type: "number", unit: "m²", min: 0 },
    { key: "operating_hours", label: { ar: "ساعات العمل", en: "Operating hours" }, type: "text" },
  ],
  qualificationFields: [
    {
      key: "project_type",
      label: { ar: "نوع المشروع", en: "Project type" },
      type: "enum",
      options: [
        { value: "on_grid", label: { ar: "مربوط بالشبكة", en: "On-grid" } },
        { value: "hybrid", label: { ar: "هجين", en: "Hybrid" } },
        { value: "off_grid", label: { ar: "منفصل عن الشبكة", en: "Off-grid" } },
        { value: "backup_bess", label: { ar: "تخزين احتياطي (بطاريات)", en: "Backup storage (BESS)" } },
      ],
    },
    { key: "project_location", label: { ar: "موقع المشروع", en: "Project location" }, type: "governorate" },
    { key: "estimated_load_kw", label: { ar: "الحمل التقديري", en: "Estimated load" }, type: "number", unit: "kW", min: 0 },
    { key: "daily_consumption_kwh", label: { ar: "الاستهلاك اليومي", en: "Daily consumption" }, type: "number", unit: "kWh", min: 0 },
    { key: "system_capacity_kwp", label: { ar: "قدرة النظام", en: "System capacity" }, type: "number", unit: "kWp", min: 0 },
    { key: "storage_capacity_kwh", label: { ar: "سعة التخزين", en: "Storage capacity" }, type: "number", unit: "kWh", min: 0 },
    { key: "site_survey_required", label: { ar: "يحتاج كشف موقعي", en: "Site survey required" }, type: "boolean" },
    { key: "site_survey_date", label: { ar: "موعد الكشف", en: "Site survey date" }, type: "date" },
    { key: "decision_maker_identified", label: { ar: "تم تحديد صاحب القرار", en: "Decision-maker identified" }, type: "boolean" },
    { key: "next_step", label: { ar: "الخطوة القادمة", en: "Next step" }, type: "text" },
  ],
  stages: [
    { key: "new_lead", label: { ar: "عميل جديد", en: "New lead" }, probability: 2 },
    { key: "researched", label: { ar: "تم البحث", en: "Researched" }, probability: 5 },
    { key: "qualified", label: { ar: "مؤهل", en: "Qualified" }, probability: 15, requires: ["project_type", "project_location"] },
    { key: "contacted", label: { ar: "تم التواصل", en: "Contacted" }, probability: 20 },
    { key: "interested", label: { ar: "مهتم", en: "Interested" }, probability: 30 },
    { key: "site_survey", label: { ar: "كشف موقعي", en: "Site survey" }, probability: 45, requires: ["site_survey_required"] },
    { key: "proposal_sent", label: { ar: "تم إرسال العرض", en: "Proposal sent" }, probability: 60, requires: ["estimated_load_kw", "system_capacity_kwp"] },
    { key: "negotiation", label: { ar: "تفاوض", en: "Negotiation" }, probability: 75, requires: ["decision_maker_identified"] },
    { key: "won", label: { ar: "تم الفوز", en: "Won" }, kind: "won", probability: 100 },
    { key: "lost", label: { ar: "خسارة", en: "Lost" }, kind: "lost", probability: 0 },
  ],
  scoring: [
    {
      key: "high_consumption_segment",
      when: { field: "attributes.segment", op: "in", value: ["factory", "hotel", "hospital", "agriculture", "retail"] },
      points: 25,
      reason: { ar: "قطاع ذو استهلاك عالٍ للطاقة", en: "High energy-consumption segment" },
    },
    {
      key: "channel_partner",
      when: { field: "attributes.segment", op: "eq", value: "channel_partner" },
      points: 20,
      reason: { ar: "شريك محتمل يمكنه إعادة البيع", en: "Potential reseller / installer partner" },
    },
    {
      key: "diesel_generator",
      when: { field: "attributes.uses_diesel_generator", op: "eq", value: true },
      points: 20,
      reason: { ar: "يعتمد على مولدة ديزل (تكلفة وقود)", en: "Relies on diesel generator (fuel cost)" },
    },
    {
      key: "limited_grid",
      when: { field: "attributes.grid_hours_per_day", op: "lte", value: 12 },
      points: 15,
      reason: { ar: "ساعات كهرباء وطنية محدودة", en: "Limited grid hours" },
    },
    {
      key: "space_available",
      when: { field: "attributes.roof_or_land_area_m2", op: "gte", value: 500 },
      points: 10,
      reason: { ar: "مساحة كافية للألواح", en: "Enough space for panels" },
    },
    { key: "in_territory", when: { field: "governorate", op: "in_territory" }, points: 10, reason: { ar: "ضمن منطقة البيع", en: "In sales territory" } },
    { key: "reachable", when: { field: "phone", op: "present" }, points: 5, reason: { ar: "رقم تواصل متوفر", en: "Contact number available" } },
    { key: "verified", when: { field: "verification_status", op: "eq", value: "verified" }, points: 5, reason: { ar: "بيانات موثقة", en: "Verified data" } },
  ],
  languages: ["ar-IQ", "ar", "en"],
  channels: ["whatsapp", "phone", "email", "in_person"],
  ai: {
    neverInvent: [
      { ar: "استهلاك الكهرباء أو الحمل لأي شركة", en: "A company's electricity consumption or load" },
      { ar: "مبالغ التوفير أو فترة استرداد الكلفة", en: "Savings amounts or payback periods" },
      { ar: "مواصفات المنتجات أو الأسعار أو الضمان إلا من قاعدة المعرفة", en: "Product specs, prices or warranty except from the knowledge base" },
      { ar: "صاحب القرار أو ميزانية المشروع أو نية الشراء", en: "Decision-maker, project budget or intention to buy" },
      { ar: "مشاريع سابقة أو شهادات عملاء غير معتمدة", en: "Past projects or testimonials not approved by the tenant" },
    ],
    escalateOn: [
      { ar: "طلب خصم أو شروط دفع خاصة", en: "Requests for discounts or special payment terms" },
      { ar: "أسئلة فنية خارج قاعدة المعرفة", en: "Technical questions outside the knowledge base" },
      { ar: "مناقصات حكومية أو عقود", en: "Government tenders or contracts" },
      { ar: "شكوى أو مشكلة في التركيب", en: "Complaints or installation issues" },
    ],
    toneGuide: {
      ar: "ودّي ومحترم باللهجة العراقية للمحادثات، ورسمي للعروض المكتوبة",
      en: "Warm and respectful Iraqi dialect for conversations; formal for written proposals",
    },
  },
});
