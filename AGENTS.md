# 小芽家庭学习源码规则

本仓库是 Windows 与手机 PWA 的唯一源码来源。app-source/src 是九个共享教学模块的来源，运行 tools/sync-core.mjs 同步后必须校验一致性。

只维护汉字、英语字母和六阶段数学启蒙。提示后答对不是独立正确；稳定掌握需要至少三个不同场次的独立正确且覆盖至少两种证据模式。家长教过但没有测试的汉字不能直接标成掌握。

禁止提交真实家庭 data、raw sessions、learning-state、动态 AI 建议、家长报告、私有家庭包、账号凭据、浏览器登录资料、交接日志或历史输出。测试使用 tools/test-fixtures.mjs 的模拟数据。发布前运行 tools/check-public.mjs、两端测试、共享核心检查及所改部分的构建检查。

家庭运行入口仍是 C:\codex\AI家庭学习；正式状态只能由软件门禁维护。原手机网址与 WorkBuddy 云服务保持不变。不得声称 GitHub Actions 已自动部署到 WorkBuddy，除非已完成原网址上的实际版本核验。
