import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide37() {
  return (
    <Frame number={37} section="Product Tour">
      <SectionTitle eyebrow="ALERTS" title="Alerts: Warning System" subtitle="Leading indicators of risk." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Predictive churn indicators</Bullet>
          <Bullet>Declining order frequency</Bullet>
          <Bullet>SKU range contraction</Bullet>
          <Bullet>Pre-empting red alerts</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex gap-[2vw]">
          <div className="flex-1 bg-[#f3b44b]/10 border border-[#f3b44b]/30 rounded p-[1.5vw] flex flex-col justify-center">
            <div className="text-[2.5vw] text-[#f3b44b] font-display text-center">XX</div>
            <div className="text-[1.5vw] text-[#a9b7c2] text-center mt-[1vh]">Distributors at Risk</div>
          </div>
          <div className="flex-[2] flex flex-col justify-center gap-[1.5vh]">
             <div className="h-[2vh] bg-[#f3b44b]/30 rounded w-[80%]" />
             <div className="h-[2vh] bg-[#f3b44b]/30 rounded w-[60%]" />
             <div className="h-[2vh] bg-[#f3b44b]/30 rounded w-[75%]" />
             <div className="h-[2vh] bg-[#f3b44b]/30 rounded w-[40%]" />
          </div>
        </div>
      </div>
    </Frame>
  );
}
