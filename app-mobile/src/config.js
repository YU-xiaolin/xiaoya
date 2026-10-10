// WorkBuddy 云服务的公开配置。这些值由云服务开通结果（publicConfig）返回，
// 可以出现在前端源码中；它们本身不携带权限，服务端会校验来源域名。
// 密钥类信息（环境 ID、provider key）不在这里，也永远不会下发到前端。
export const CLOUD_CONFIG = Object.freeze({
  applicationId: "wbapp_GmOXzpfOUNz2OjF2Hyvdj9",
  endpoint: "https://xiaoya-learning.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_GmOXzpfOUNz2OjF2Hyvdj9_B4A2hcHXU4KX4cvUwf1QLoHRx9OsNC51"
});

export const APP_VERSION = "0.3.1";

// 学习记录与课程的稳定协议名。与 Windows 端 data/schemas 保持一致，便于互相导入导出。
export const PROTOCOLS = Object.freeze({
  session: "FAMILY_LEARNING_SESSION_V1",
  lesson: "FAMILY_LEARNING_LESSON_V1",
  coursePackage: "XIAOYA_COURSE_PACKAGE_V1",
  recordBundle: "XIAOYA_RECORD_BUNDLE_V1"
});

// 默认学生编号：匿名、可改，不采集真实姓名。
export const DEFAULT_STUDENT_CODE = "student-01";
