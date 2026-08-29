import { Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide11() {
  return (
    <Frame number={11} section="10 / ALERTS & WARNINGS">
      <SectionTitle eyebrow="10 / ALERTS & WARNINGS" title="Act before risk becomes a result" />
      <div className="absolute left-[7vw] top-[42vh] w-[31vw]">
        <div className="panel p-[2vw]">
          <div className="flex items-center justify-between"><span className="thin-label">PRIORITY QUEUE</span><Pill tone="red">REVIEWABLE</Pill></div>
          <div className="mt-[2.8vh] space-y-[1vw]"><div className="panel-soft flex items-center gap-[1vw] p-[1.1vw]"><span className="h-[1vw] w-[1vw] rounded-full bg-[#ff6e66]" /><span className="text-[1.5vw]">High-priority signal</span><span className="ml-auto text-[1.5vw] text-[#ffaaa3]">NOW</span></div><div className="panel-soft flex items-center gap-[1vw] p-[1.1vw]"><span className="h-[1vw] w-[1vw] rounded-full bg-[#f3b44b]" /><span className="text-[1.5vw]">Leading indicator</span><span className="ml-auto text-[1.5vw] text-[#ffd58b]">SOON</span></div><div className="panel-soft flex items-center gap-[1vw] p-[1.1vw]"><span className="h-[1vw] w-[1vw] rounded-full bg-[#4ccfa3]" /><span className="text-[1.5vw]">Context check</span><span className="ml-auto text-[1.5vw] text-[#9be9cf]">READY</span></div></div>
        </div>
      </div>
      <div className="absolute right-[7vw] top-[42vh] w-[42vw] space-y-[2.1vh]">
        <div className="flex gap-[1.4vw]"><div className="font-display text-[2vw] font-semibold text-[#ff6e66]">01</div><p className="body-copy">Red Alerts highlight high-priority business signals</p></div>
        <div className="flex gap-[1.4vw]"><div className="font-display text-[2vw] font-semibold text-[#f3b44b]">02</div><p className="body-copy">Warning System adds earlier leading indicators</p></div>
        <div className="flex gap-[1.4vw]"><div className="font-display text-[2vw] font-semibold text-[#6ec5ff]">03</div><p className="body-copy">Alert Settings support controlled routing and escalation</p></div>
        <div className="flex gap-[1.4vw]"><div className="font-display text-[2vw] font-semibold text-[#4ccfa3]">04</div><p className="body-copy">Every alert is designed to point toward a reviewable action</p></div>
      </div>
    </Frame>
  );
}