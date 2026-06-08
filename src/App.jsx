import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  ConfigProvider,
  Divider,
  Empty,
  Input,
  List,
  Modal,
  Progress,
  Row,
  Space,
  Statistic,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from "antd";
import {
  CheckCircleOutlined,
  ClearOutlined,
  ClockCircleOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EnvironmentOutlined,
  ExperimentOutlined,
  GlobalOutlined,
  LoadingOutlined,
  MessageOutlined,
  PhoneOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  StarOutlined,
  StopOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { exportRowsAsCsv } from "./utils/exporter";

const { Title, Text, Paragraph } = Typography;

// ── Data field definitions ──
const dataFields = [
  { label: "Name", value: "name" },
  { label: "Phone", value: "phone" },
  { label: "Address", value: "address" },
  { label: "Rating", value: "rating" },
  { label: "Website", value: "website" },
];

// ── Ant Design theme ──
const antTheme = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: "#1677ff",
    borderRadius: 10,
    colorBgContainer: "#ffffff",
  },
  components: {
    Card: { borderRadiusLG: 12 },
    Button: { borderRadius: 8 },
    Input: { borderRadius: 8 },
  },
};

// ── Chrome API helpers ──
const isChromeExtension = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage;

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    if (!isChromeExtension) {
      reject(new Error("Not in Chrome extension context"));
      return;
    }
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

function App() {
  const [messageApi, contextHolder] = message.useMessage();

  // ── State ──
  const [keywordsData, setKeywordsData] = useState({});
  const [keyword, setKeyword] = useState("");
  const [selectedFields, setSelectedFields] = useState(["name", "phone", "address", "rating", "website"]);
  const [activeTab, setActiveTab] = useState("home");
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeStatus, setScrapeStatus] = useState({ saved: 0, processed: 0, message: "Idle" });

  const statusPollRef = useRef(null);

  // ── Derived ──
  const settings = useMemo(
    () => ({
      name: selectedFields.includes("name"),
      phone: selectedFields.includes("phone"),
      address: selectedFields.includes("address"),
      rating: selectedFields.includes("rating"),
      website: selectedFields.includes("website"),
    }),
    [selectedFields],
  );

  const keys = useMemo(() => Object.keys(keywordsData), [keywordsData]);
  const totalLeads = useMemo(
    () => Object.values(keywordsData).reduce((sum, arr) => sum + arr.length, 0),
    [keywordsData],
  );

  // ── Load data from storage on mount + listen for changes ──
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage) return;

    chrome.storage.local.get(["keywordsData", "scrapeSettings", "autoScrape"], (result) => {
      if (result.keywordsData) setKeywordsData(result.keywordsData);
      if (result.scrapeSettings) {
        const s = result.scrapeSettings;
        setSelectedFields(
          ["name", "phone", "address", "rating", "website"].filter((f) => s[f] !== false),
        );
      }
      if (result.autoScrape) setIsScraping(true);
    });

    const onChange = (changes, area) => {
      if (area !== "local") return;
      if (changes.keywordsData) {
        setKeywordsData(changes.keywordsData.newValue || {});
      }
      if (changes.autoScrape) {
        const val = Boolean(changes.autoScrape.newValue);
        setIsScraping(val);
        if (changes.autoScrape.oldValue === true && !val) {
          messageApi.success("Scraping session finished!");
        }
      }
    };

    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [messageApi]);

  // ── Poll scrape status while active ──
  useEffect(() => {
    if (isScraping && isChromeExtension) {
      statusPollRef.current = setInterval(() => {
        sendMsg({ action: "getStatus" })
          .then((resp) => {
            if (resp) {
              setScrapeStatus({
                saved: resp.saved || 0,
                processed: resp.processed || 0,
                message: resp.message || "Working...",
              });
              if (!resp.scraping) {
                setIsScraping(false);
              }
            }
          })
          .catch(() => {});
      }, 2000);
    } else {
      clearInterval(statusPollRef.current);
    }
    return () => clearInterval(statusPollRef.current);
  }, [isScraping]);

  // ── Actions ──
  const handleStartScrape = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) {
      messageApi.warning("Enter a keyword to search.");
      return;
    }
    if (!selectedFields.length) {
      messageApi.warning("Select at least one data field.");
      return;
    }

    try {
      await sendMsg({ action: "startScrape", keyword: kw, settings });
      setIsScraping(true);
      setScrapeStatus({ saved: 0, processed: 0, message: "Starting..." });
      messageApi.success(`Scraping started for "${kw}"`);
    } catch (err) {
      messageApi.error("Failed to start: " + err.message);
    }
  }, [keyword, settings, selectedFields, messageApi]);

  const handleStopScrape = useCallback(async () => {
    try {
      await sendMsg({ action: "stopScrape" });
      setIsScraping(false);
      messageApi.info("Scraping stopped.");
    } catch (err) {
      messageApi.error("Failed to stop: " + err.message);
    }
  }, [messageApi]);

  const deleteKeyword = useCallback(
    (kw) => {
      Modal.confirm({
        title: `Delete data for "${kw}"?`,
        content: "This cannot be undone.",
        okText: "Delete",
        okType: "danger",
        onOk: () => {
          const updated = { ...keywordsData };
          delete updated[kw];
          setKeywordsData(updated);
          if (chrome.storage) {
            chrome.storage.local.set({ keywordsData: updated }, () => {
              messageApi.success(`Deleted "${kw}"`);
            });
          }
        },
      });
    },
    [keywordsData, messageApi],
  );

  const clearAll = useCallback(() => {
    Modal.confirm({
      title: "Clear all data?",
      content: "Every saved keyword and lead will be permanently removed.",
      okText: "Clear all",
      okType: "danger",
      onOk: () => {
        setKeywordsData({});
        if (chrome.storage) {
          chrome.storage.local.set({ keywordsData: {} }, () => {
            messageApi.success("All data cleared.");
          });
        }
      },
    });
  }, [messageApi]);

  const exportCSV = useCallback(
    (kw) => {
      const leads = keywordsData[kw];
      if (!leads || leads.length === 0) {
        messageApi.warning(`No data for "${kw}"`);
        return;
      }
      const headers = ["Name", "Phone", "Address", "Rating", "Website"];
      const rows = leads.map((l) => [
        l.name || "",
        l.phone || "",
        l.address || "",
        l.rating || "",
        l.website || "",
      ]);
      const filename = `${kw.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${leads.length}_leads.csv`;
      exportRowsAsCsv(filename, headers, rows);
      messageApi.success(`Exported ${leads.length} leads`);
    },
    [keywordsData, messageApi],
  );

  const exportAllCSV = useCallback(() => {
    if (keys.length === 0) {
      messageApi.warning("No data to export.");
      return;
    }
    const allLeads = keys.flatMap((kw) =>
      (keywordsData[kw] || []).map((l) => ({ ...l, keyword: kw })),
    );
    const headers = ["Keyword", "Name", "Phone", "Address", "Rating", "Website"];
    const rows = allLeads.map((l) => [
      l.keyword || "",
      l.name || "",
      l.phone || "",
      l.address || "",
      l.rating || "",
      l.website || "",
    ]);
    const ts = new Date().toISOString().slice(0, 10);
    exportRowsAsCsv(`all_leads_${ts}.csv`, headers, rows);
    messageApi.success(`Exported ${allLeads.length} leads from ${keys.length} keywords`);
  }, [keys, keywordsData, messageApi]);

  const openWhatsApp = useCallback(
    (phone) => {
      if (!phone) return;
      const clean = phone.replace(/\D/g, "");
      if (clean.length >= 7) {
        window.open(`https://wa.me/${clean}`, "_blank");
      } else {
        messageApi.warning("Invalid phone number");
      }
    },
    [messageApi],
  );

  // ══════════════════════════════════════════════
  // ── HOME TAB ──
  // ══════════════════════════════════════════════
  const renderHomeTab = () => (
    <Space direction="vertical" size={14} style={{ width: "100%" }}>
      {/* Header */}
      <div className="app-header">
        <Space align="center" size={12}>
          <ExperimentOutlined style={{ fontSize: 28, color: "#fff" }} />
          <div>
            <Title level={4} style={{ margin: 0, color: "#fff" }}>
              Maps Lead Extractor
            </Title>
            <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 12 }}>
              Scrape Google Maps business data in one click
            </Text>
          </div>
        </Space>
        <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
          <Tag color="blue" style={{ margin: 0 }}>
            <ThunderboltOutlined /> Fast
          </Tag>
          <Tag color="cyan" style={{ margin: 0 }}>
            <EnvironmentOutlined /> Maps
          </Tag>
          <Tag color="green" style={{ margin: 0 }}>
            <CloudDownloadOutlined /> CSV Export
          </Tag>
        </div>
      </div>

      {/* Search */}
      <Card size="small" title="Search keyword" styles={{ header: { borderBottom: "1px solid #f0f0f0" } }}>
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Input
            size="large"
            prefix={<SearchOutlined style={{ color: "#bfbfbf" }} />}
            placeholder='e.g. "plumbers in London"'
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={handleStartScrape}
            disabled={isScraping}
          />

          <div>
            <Text strong style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
              Data fields to collect
            </Text>
            <Checkbox.Group
              options={dataFields}
              value={selectedFields}
              onChange={setSelectedFields}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 4,
              }}
            />
          </div>

          {isScraping ? (
            <Button
              danger
              type="primary"
              icon={<StopOutlined />}
              block
              size="large"
              onClick={handleStopScrape}
            >
              Stop Scraping
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              block
              size="large"
              onClick={handleStartScrape}
            >
              Start Scraping
            </Button>
          )}
        </Space>
      </Card>

      {/* Live Status */}
      {isScraping && (
        <Card
          size="small"
          title={
            <Space>
              <span className="status-dot-active" />
              <Text strong>Scraping in progress</Text>
            </Space>
          }
        >
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              <LoadingOutlined spin style={{ marginRight: 6 }} />
              {scrapeStatus.message}
            </Text>
            <Row gutter={12}>
              <Col span={12}>
                <Statistic
                  title="Saved"
                  value={scrapeStatus.saved}
                  prefix={<CheckCircleOutlined style={{ color: "#52c41a" }} />}
                  valueStyle={{ fontSize: 20, color: "#52c41a" }}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="Processed"
                  value={scrapeStatus.processed}
                  prefix={<ClockCircleOutlined style={{ color: "#1677ff" }} />}
                  valueStyle={{ fontSize: 20, color: "#1677ff" }}
                />
              </Col>
            </Row>
            {scrapeStatus.processed > 0 && (
              <Progress
                percent={Math.round((scrapeStatus.saved / scrapeStatus.processed) * 100)}
                size="small"
                status="active"
                format={(pct) => `${pct}% captured`}
              />
            )}
          </Space>
        </Card>
      )}

      {/* Quick stats when not scraping */}
      {!isScraping && totalLeads > 0 && (
        <Card size="small">
          <Row gutter={12}>
            <Col span={12}>
              <Statistic title="Keywords" value={keys.length} valueStyle={{ fontSize: 18 }} />
            </Col>
            <Col span={12}>
              <Statistic
                title="Total Leads"
                value={totalLeads}
                valueStyle={{ fontSize: 18, color: "#1677ff" }}
              />
            </Col>
          </Row>
          <Divider style={{ margin: "10px 0" }} />
          <Button block onClick={() => setActiveTab("data")} icon={<EnvironmentOutlined />}>
            View Collected Data
          </Button>
        </Card>
      )}
    </Space>
  );

  // ══════════════════════════════════════════════
  // ── DATA TAB ──
  // ══════════════════════════════════════════════
  const renderDataTab = () => (
    <Space direction="vertical" size={14} style={{ width: "100%" }}>
      {/* Stats */}
      <Row gutter={12}>
        <Col span={12}>
          <Card size="small">
            <Statistic title="Keywords" value={keys.length} valueStyle={{ fontSize: 20 }} />
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small">
            <Statistic
              title="Total Leads"
              value={totalLeads}
              valueStyle={{ fontSize: 20, color: "#1677ff" }}
            />
          </Card>
        </Col>
      </Row>

      {/* Action buttons */}
      <Space style={{ width: "100%", justifyContent: "flex-end" }}>
        <Button
          icon={<DownloadOutlined />}
          onClick={exportAllCSV}
          disabled={keys.length === 0}
          type="primary"
          ghost
        >
          Export All CSV
        </Button>
        <Button
          danger
          icon={<ClearOutlined />}
          onClick={clearAll}
          disabled={keys.length === 0}
        >
          Clear All
        </Button>
      </Space>

      {/* Keyword cards */}
      {keys.length === 0 ? (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No data yet. Start scraping from the Home tab."
          />
        </Card>
      ) : (
        keys.map((kw) => {
          const leads = keywordsData[kw] || [];
          return (
            <Card
              key={kw}
              size="small"
              title={
                <Space>
                  <SearchOutlined />
                  <Text strong>{kw}</Text>
                  <Badge
                    count={leads.length}
                    style={{ backgroundColor: "#1677ff" }}
                    overflowCount={999}
                  />
                </Space>
              }
              extra={
                <Space size={4}>
                  <Tooltip title="Export as CSV">
                    <Button
                      size="small"
                      type="text"
                      icon={<DownloadOutlined />}
                      onClick={() => exportCSV(kw)}
                    />
                  </Tooltip>
                  <Tooltip title="Delete keyword data">
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => deleteKeyword(kw)}
                    />
                  </Tooltip>
                </Space>
              }
            >
              {leads.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No leads." />
              ) : (
                <>
                  <List
                    size="small"
                    dataSource={leads.slice(0, 5)}
                    renderItem={(lead, idx) => (
                      <List.Item
                        key={idx}
                        className="lead-item"
                        style={{ padding: "8px 4px" }}
                        actions={
                          lead.phone
                            ? [
                                <Tooltip title={`WhatsApp: ${lead.phone}`} key="wa">
                                  <Button
                                    size="small"
                                    type="link"
                                    icon={<MessageOutlined />}
                                    onClick={() => openWhatsApp(lead.phone)}
                                  />
                                </Tooltip>,
                              ]
                            : []
                        }
                      >
                        <List.Item.Meta
                          title={
                            <Text strong style={{ fontSize: 13 }}>
                              <UserOutlined style={{ marginRight: 4, color: "#1677ff" }} />
                              {lead.name || "Unnamed"}
                            </Text>
                          }
                          description={
                            <Space direction="vertical" size={2} style={{ fontSize: 11 }}>
                              {lead.phone && (
                                <Text type="secondary">
                                  <PhoneOutlined style={{ marginRight: 4 }} />
                                  {lead.phone}
                                </Text>
                              )}
                              {lead.address && (
                                <Text type="secondary" style={{ maxWidth: 220 }} ellipsis>
                                  <EnvironmentOutlined style={{ marginRight: 4 }} />
                                  {lead.address}
                                </Text>
                              )}
                              {lead.rating && (
                                <Text type="secondary">
                                  <StarOutlined style={{ marginRight: 4, color: "#faad14" }} />
                                  {lead.rating}
                                </Text>
                              )}
                              {lead.website && (
                                <Text type="secondary" style={{ maxWidth: 220 }} ellipsis>
                                  <GlobalOutlined style={{ marginRight: 4 }} />
                                  {lead.website}
                                </Text>
                              )}
                            </Space>
                          }
                        />
                      </List.Item>
                    )}
                  />
                  {leads.length > 5 && (
                    <div
                      style={{
                        textAlign: "center",
                        padding: "6px 0",
                        color: "#8c8c8c",
                        fontSize: 12,
                      }}
                    >
                      + {leads.length - 5} more — export CSV to see all
                    </div>
                  )}
                </>
              )}
            </Card>
          );
        })
      )}
    </Space>
  );

  // ══════════════════════════════════════════════
  // ── HELP TAB ──
  // ══════════════════════════════════════════════
  const renderHelpTab = () => (
    <Space direction="vertical" size={14} style={{ width: "100%" }}>
      <Alert
        showIcon
        type="info"
        message="How it works"
        description="This extension scrapes business data from Google Maps search results. Data is saved locally and exported as CSV when you choose."
      />

      <Card size="small" title="Quick start">
        <List
          size="small"
          dataSource={[
            'Enter a search keyword like "restaurants in NYC".',
            "Choose which data fields to collect.",
            "Click Start Scraping — a Maps tab opens automatically.",
            "Watch live progress in the popup or the floating badge.",
            "Go to the Data tab to review and export your leads.",
          ]}
          renderItem={(item, i) => (
            <List.Item style={{ padding: "6px 0" }}>
              <Space align="start" size={10}>
                <Tag color="blue" style={{ minWidth: 24, textAlign: "center" }}>
                  {i + 1}
                </Tag>
                <Text style={{ fontSize: 13 }}>{item}</Text>
              </Space>
            </List.Item>
          )}
        />
      </Card>

      <Card size="small" title="Tips">
        <Space direction="vertical" size={6}>
          <Text style={{ fontSize: 13 }}>
            <ThunderboltOutlined style={{ color: "#faad14", marginRight: 6 }} />
            <strong>Be specific</strong> — "dentists in Brooklyn NY" works better than "dentists".
          </Text>
          <Text style={{ fontSize: 13 }}>
            <PhoneOutlined style={{ color: "#1677ff", marginRight: 6 }} />
            <strong>Phone numbers</strong> are only available if the business has listed one on Google Maps.
          </Text>
          <Text style={{ fontSize: 13 }}>
            <CloudDownloadOutlined style={{ color: "#52c41a", marginRight: 6 }} />
            <strong>No auto-downloads</strong> — your data stays in local storage until you manually export.
          </Text>
        </Space>
      </Card>

      <Card size="small" title="About">
        <Text type="secondary" style={{ fontSize: 12 }}>
          Google Maps Data Extractor v2.0 — Built with React & Ant Design.
          Data is stored locally in your browser and never sent to any server.
        </Text>
      </Card>
    </Space>
  );

  // ══════════════════════════════════════════════
  // ── RENDER ──
  // ══════════════════════════════════════════════
  return (
    <ConfigProvider theme={antTheme}>
      <AntdApp>
        {contextHolder}
        <div style={{ padding: 10, maxWidth: 400, margin: "0 auto" }}>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            centered
            size="small"
            items={[
              {
                key: "home",
                label: (
                  <Space size={4}>
                    <SearchOutlined />
                    Home
                  </Space>
                ),
                children: renderHomeTab(),
              },
              {
                key: "data",
                label: (
                  <Space size={4}>
                    <EnvironmentOutlined />
                    Data
                    {totalLeads > 0 && (
                      <Badge
                        count={totalLeads}
                        size="small"
                        style={{ backgroundColor: "#1677ff" }}
                        overflowCount={99}
                      />
                    )}
                  </Space>
                ),
                children: renderDataTab(),
              },
              {
                key: "help",
                label: (
                  <Space size={4}>
                    <ExperimentOutlined />
                    Help
                  </Space>
                ),
                children: renderHelpTab(),
              },
            ]}
          />
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
