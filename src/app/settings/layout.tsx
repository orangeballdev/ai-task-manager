import SettingsNav from "./SettingsNav";
import SettingsSearch from "./SettingsSearch";
import SettingHighlighter from "./SettingHighlighter";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Settings</h1>
      <SettingsSearch />
      <SettingsNav />
      <SettingHighlighter />
      <div className="mt-6">{children}</div>
    </div>
  );
}
