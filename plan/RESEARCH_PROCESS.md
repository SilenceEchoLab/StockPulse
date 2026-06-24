## Startup Phase

开始研究前必须执行：

### Step 1

阅读：

docs/

### Step 2

总结：

* 当前系统结构
* 已知有效规律
* 已知失败案例
* 当前冠军策略

生成：

research/context/current_state.md

---

## Research Loop

每轮执行：

### 1. Review

分析：

* 历史实验
* Champion策略
* 最近失败原因

---

### 2. Generate Hypothesis

提出：

一个明确可验证的假设

示例：

市场波动率过高时RSI策略失效

---

### 3. Implement

修改：

策略代码

不得修改多个无关方向。

---

### 4. Backtest

运行完整回测。

不得只运行局部数据。

必须执行：

Walk Forward Validation

---

### 5. Evaluate

记录：

* CAGR
* Annual Return
* Sharpe
* Sortino
* Profit Factor
* Win Rate
* Max Drawdown
* Average Holding Days

---

### 6. Compare

与Champion比较。

如果不超过Champion：

标记失败。

---

### 7. Learn

总结：

成功原因

失败原因

市场条件

适用场景

---

### 8. Save

写入：

research/experiments/

research/findings/

research/failures/

---

### 9. Continue

基于最新发现生成下一轮研究方向。

不得重复已经失败的实验。
