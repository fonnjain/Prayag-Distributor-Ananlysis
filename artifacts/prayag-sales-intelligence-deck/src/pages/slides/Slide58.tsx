import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide58() {
  return (
    <Frame number={58} section="Product Tour">
      <SectionTitle eyebrow="DEVELOPER" title="APIs & Master Data" subtitle="Integration and catalogue management." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>REST APIs for ERP integration</Bullet>
          <Bullet>Secure API Key management</Bullet>
          <Bullet>Master catalogue review workflow</Bullet>
          <Bullet>Schema and payload documentation</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[2vh] bg-[#08121f] font-mono border-[#1389e8]/30">
          <div className="text-[1.5vw] text-[#a9b7c2]">POST /api/v1/sync/primary</div>
          <div className="text-[1.5vw] text-[#4ccfa3]">
            {`{`} <br/>
            &nbsp;&nbsp;"timestamp": "XXXX-XX-XX...", <br/>
            &nbsp;&nbsp;"records_processed": "XXXX", <br/>
            &nbsp;&nbsp;"status": "success" <br/>
            {`}`}
          </div>
        </div>
      </div>
    </Frame>
  );
}
